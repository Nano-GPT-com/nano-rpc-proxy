const axios = require('axios');
const fs = require('fs');
const path = require('path');
const util = require('util');
const {
  getDepositJob,
  deleteDepositJob,
  markSeen,
  isSeen,
  readStatus,
  saveStatus,
  formatAtomicAmount,
  toBigInt,
  upsertDepositLedgerFirstSeen,
  recordDepositLedgerWebhookResult
} = require('./deposits');
const { normalizeTicker } = require('./watcher-config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const createLogger = (level = 'info', errorFile = '') => {
  const current = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const prefix = '[watcher]';
  const should = (lvl) => (LOG_LEVELS[lvl] ?? LOG_LEVELS.info) <= current;
  const logToFile = (lvl, args) => {
    if (!errorFile) return;
    const line =
      `${new Date().toISOString()} [${lvl}] ` +
      util.format(...args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a))) +
      '\n';
    fs.appendFile(errorFile, line, () => {});
  };

  return {
    error: (...args) => {
      if (should('error')) console.error(prefix, ...args);
      logToFile('error', args);
    },
    warn: (...args) => {
      if (should('warn')) console.warn(prefix, ...args);
      logToFile('warn', args);
    },
    info: (...args) => should('info') && console.log(prefix, ...args),
    debug: (...args) => should('debug') && console.debug(prefix, ...args)
  };
};

let watcherLogger = createLogger(process.env.WATCHER_LOG_LEVEL || 'info', process.env.WATCHER_LOG_ERROR_FILE || '');

const safePathSegment = (value) => String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_');

const readJsonFileIfExists = async (filePath) => {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

const writeJsonFileAtomic = async (filePath, value) => {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(value), 'utf8');
  await fs.promises.rename(tmpPath, filePath);
};

const persistDepositLedgerFirstSeen = async (kv, ticker, hash, data, config) => {
  const mode = String(config.depositLedgerMode || '').toLowerCase();
  if (!mode || mode === 'off' || mode === 'disabled' || mode === 'false' || mode === '0') return;

  if (mode === 'disk') {
    const baseDir = String(config.depositLedgerDir || '').trim();
    if (!baseDir) return;
    const t = safePathSegment(normalizeTicker(ticker));
    const h = safePathSegment(hash);
    const filePath = path.join(baseDir, 'deposit-ledger', t, `${h}.json`);
    const nowIso = new Date().toISOString();
    const existing = (await readJsonFileIfExists(filePath)) || {};
    const next = { ...existing };

    if (!next.firstSeenAt) next.firstSeenAt = nowIso;
    next.lastSeenAt = nowIso;

    if (!next.paymentId && data?.paymentId) next.paymentId = String(data.paymentId);
    if (!next.clientReference && data?.clientReference) next.clientReference = String(data.clientReference);
    if (!next.amountAtomic && data?.amountAtomic !== undefined) next.amountAtomic = String(data.amountAtomic);
    if (!next.assetId && data?.assetId) next.assetId = String(data.assetId);

    await writeJsonFileAtomic(filePath, next);
    return;
  }

  await upsertDepositLedgerFirstSeen(
    kv,
    ticker,
    hash,
    data,
    { ttlSeconds: config.depositLedgerTtlSeconds, keyPrefix: config.keyPrefix }
  );
};

const persistDepositLedgerWebhookResult = async (kv, ticker, hash, webhook, config) => {
  const mode = String(config.depositLedgerMode || '').toLowerCase();
  if (!mode || mode === 'off' || mode === 'disabled' || mode === 'false' || mode === '0') return;

  if (mode === 'disk') {
    const baseDir = String(config.depositLedgerDir || '').trim();
    if (!baseDir) return;
    const t = safePathSegment(normalizeTicker(ticker));
    const h = safePathSegment(hash);
    const filePath = path.join(baseDir, 'deposit-webhooks', t, `${h}.json`);
    const value = {
      ticker: normalizeTicker(ticker),
      hash,
      lastAttemptAt: webhook?.attemptedAt ? String(webhook.attemptedAt) : String(Date.now()),
      lastOk: Boolean(webhook?.ok),
      lastStatusCode: webhook?.statusCode === undefined || webhook?.statusCode === null ? null : webhook.statusCode,
      lastError: webhook?.error ? String(webhook.error) : '',
      attempts: webhook?.attempts === undefined || webhook?.attempts === null ? null : webhook.attempts
    };
    await writeJsonFileAtomic(filePath, value);
    return;
  }

  await recordDepositLedgerWebhookResult(
    kv,
    ticker,
    hash,
    webhook,
    { ttlSeconds: config.depositLedgerTtlSeconds, keyPrefix: config.keyPrefix }
  );
};

const asNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const truncateText = (value, maxLen = 500) => {
  const text = value === undefined || value === null ? '' : String(value);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen);
};

const computeWebhookBackoffDelayMs = (attempts, config) => {
  const baseMs = asNumber(config.webhookBackoffBaseMs, 1000);
  const factor = asNumber(config.webhookBackoffFactor, 2);
  const maxMs = asNumber(config.webhookBackoffMaxMs, 20 * 60 * 1000);

  let delay = baseMs * Math.pow(factor, Math.max(0, attempts));
  delay = Math.min(delay, maxMs);

  if (config.webhookBackoffJitter) {
    delay = Math.floor(Math.random() * delay);
  }

  return Math.max(0, Math.floor(delay));
};

const computeDynamicMinConfirmations = (amountAtomic, decimals) => {
  const atomic = toBigInt(amountAtomic);
  if (atomic === null) return null;

  const safeDecimals =
    Number.isFinite(decimals) && decimals >= 0 ? decimals : 12;
  const scale = BigInt(10) ** BigInt(safeDecimals);
  const threshold50 = BigInt(50) * scale;
  const threshold100 = BigInt(100) * scale;

  if (atomic < threshold50) return 1;
  if (atomic < threshold100) return 3;
  return 6;
};

const normalizeHash = (value) => (value || '').trim();

const flattenDeposits = (payload) => {
  if (!payload) return [];

  const candidates = [];
  const possibleArrays = [
    payload.deposits,
    payload.transactions,
    payload.items,
    payload.result?.deposits,
    payload.result?.transactions,
    payload.result?.entries,
    payload.result?.in,
    payload.result?.transfers,
    payload.result
  ];

  for (const arr of possibleArrays) {
    if (Array.isArray(arr)) {
      candidates.push(...arr);
    }
  }

  if (Array.isArray(payload)) {
    candidates.push(...payload);
  }

  return candidates;
};

const normalizeDeposits = (payload, address, ticker) => {
  const deposits = new Map();

  for (const entry of flattenDeposits(payload)) {
    const hash = normalizeHash(
      entry?.hash ||
        entry?.tx_hash ||
        entry?.txHash ||
        entry?.txid ||
        entry?.transactionHash
    );

    const amountAtomic = entry?.amountAtomic ?? entry?.amount_atomic ?? entry?.amount ?? entry?.value;
    const confirmations = asNumber(
      entry?.confirmations ??
        entry?.conf ??
        entry?.num_confirmations ??
        entry?.confirmations_count ??
        entry?.confirmed,
      0
    );
    const addr = entry?.address || entry?.dest || entry?.destination || address;

    if (!hash || amountAtomic === undefined || amountAtomic === null) {
      continue;
    }

    const normalized = {
      hash,
      amountAtomic,
      confirmations,
      address: addr,
      ticker
    };

    const existing = deposits.get(hash);
    if (!existing || confirmations > existing.confirmations) {
      deposits.set(hash, normalized);
    }
  }

  return Array.from(deposits.values());
};

const rpcError = (message, cause) => {
  const error = new Error(message);
  error.isRpcError = true;
  if (cause) error.cause = cause;
  return error;
};

const fetchViaStatusApi = async (address, ticker, config) => {
  if (!config.zanoStatusUrl) return [];

  const response = await axios.get(config.zanoStatusUrl, {
    params: { address, ticker },
    timeout: Math.max(config.webhookTimeoutMs, 10000),
    validateStatus: () => true
  });

  if (response.status >= 400) {
    throw rpcError(`Status API returned ${response.status}`, response.data);
  }

  return normalizeDeposits(response.data, address, ticker);
};

const fetchViaRpc = async (address, ticker, config, paymentId) => {
  if (!config.zanoRpcUrl) return [];
  if (!paymentId) {
    watcherLogger.debug('RPC fetch skipped (no paymentId)', { ticker, address });
    return [];
  }

  // First: get current height via get_wallet_info
  const heightPayload = {
    jsonrpc: '2.0',
    id: `wallet-info-${Date.now()}`,
    method: 'get_wallet_info',
    params: {}
  };

  const heightResp = await axios.post(config.zanoRpcUrl, heightPayload, {
    auth: config.zanoRpcUser
      ? {
          username: config.zanoRpcUser,
          password: config.zanoRpcPassword || ''
        }
      : undefined,
    timeout: Math.max(config.webhookTimeoutMs, 8000),
    validateStatus: () => true
  });

  if (heightResp.status >= 400 || heightResp.data?.error) {
    throw rpcError(
      `Zano RPC error ${heightResp.status}: ${heightResp.data?.error?.message || 'unknown'}`,
      heightResp.data
    );
  }

  const walletInfo = heightResp.data?.result || {};
  const currentHeight = asNumber(walletInfo.current_height, 0);
  const daemonHeight = asNumber(walletInfo.daemon_height, 0);
  const isSynced = walletInfo.is_synchronized;
  const expectedAssetId = (config.assetIds?.[ticker] || '').trim();

  watcherLogger.debug('Wallet sync status', {
    ticker,
    paymentId,
    walletHeight: currentHeight,
    daemonHeight,
    isSynced,
    heightDiff: daemonHeight - currentHeight
  });

  let payments = [];
  if (!expectedAssetId) {
    // Then: get payments (returns block_height). Only safe for base coin deposits.
    const payPayload = {
      jsonrpc: '2.0',
      id: `watcher-${Date.now()}`,
      method: 'get_payments',
      params: { payment_id: paymentId }
    };

    const payResp = await axios.post(config.zanoRpcUrl, payPayload, {
      auth: config.zanoRpcUser
        ? {
            username: config.zanoRpcUser,
            password: config.zanoRpcPassword || ''
          }
        : undefined,
      timeout: Math.max(config.webhookTimeoutMs, 10000),
      validateStatus: () => true
    });

    if (payResp.status >= 400 || payResp.data?.error) {
      throw rpcError(
        `Zano RPC error ${payResp.status}: ${payResp.data?.error?.message || 'unknown'}`,
        payResp.data
      );
    }

    payments = payResp.data?.result?.payments || [];

    watcherLogger.debug('get_payments raw response', {
      ticker,
      paymentId,
      statusCode: payResp.status,
      hasError: Boolean(payResp.data?.error),
      errorMessage: payResp.data?.error?.message,
      paymentsCount: payments.length,
      resultKeys: Object.keys(payResp.data?.result || {}),
      fullResult: JSON.stringify(payResp.data?.result || {}).substring(0, 500)
    });
  } else {
    watcherLogger.debug('get_payments skipped (asset ticker)', {
      ticker,
      paymentId,
      expectedAssetId
    });
  }

  const byHash = new Map();
  for (const p of payments) {
    const height = asNumber(p.block_height, 0);
    const confirmations =
      height > 0 && currentHeight > 0
        ? Math.max(currentHeight - height + 1, 0) // inclusive of mined block
        : asNumber(p.confirmations, 0);
    const entry = {
      hash: p.tx_hash,
      amountAtomic: p.amount,
      confirmations,
      address,
      ticker
    };
    const existing = byHash.get(entry.hash);
    if (!existing || confirmations > existing.confirmations) {
      byHash.set(entry.hash, entry);
    }
  }

  if (byHash.size === 0) {
    try {
      const recentPayload = {
        jsonrpc: '2.0',
        id: `recent-txs-${Date.now()}`,
        method: 'get_recent_txs_and_info2',
        params: {
          offset: 0,
          count: 200,
          exclude_mining_txs: true,
          exclude_unconfirmed: false,
          order: 'FROM_END_TO_BEGIN',
          update_provision_info: true
        }
      };

      const recentResp = await axios.post(config.zanoRpcUrl, recentPayload, {
        auth: config.zanoRpcUser
          ? {
              username: config.zanoRpcUser,
              password: config.zanoRpcPassword || ''
            }
          : undefined,
        timeout: Math.max(config.webhookTimeoutMs, 10000),
        validateStatus: () => true
      });

      if (recentResp.status < 400 && !recentResp.data?.error) {
        const transfers = recentResp.data?.result?.transfers || [];
        for (const tx of transfers) {
          if (tx?.payment_id !== paymentId) continue;

          const txHash = tx?.tx_hash;
          const height = asNumber(tx?.height, 0);
          const confirmations =
            height > 0 && currentHeight > 0 ? Math.max(currentHeight - height + 1, 0) : 0;

          const subtransfers = Array.isArray(tx?.subtransfers) ? tx.subtransfers : [];
          for (const st of subtransfers) {
            if (!st?.is_income) continue;
            const subAssetId = (st?.asset_id || '').toString().trim();
            if (expectedAssetId) {
              if (subAssetId !== expectedAssetId) continue;
            } else {
              // Base coin ticker: ignore asset subtransfers (prevents FUSD being miscredited as ZANO).
              if (subAssetId) continue;
            }

            const entry = {
              hash: txHash,
              amountAtomic: st.amount,
              confirmations,
              address,
              ticker
            };

            if (!entry.hash || entry.amountAtomic === undefined || entry.amountAtomic === null) continue;

            const existing = byHash.get(entry.hash);
            if (!existing || confirmations > existing.confirmations) {
              byHash.set(entry.hash, entry);
            }
          }
        }

        watcherLogger.debug('Fallback get_recent_txs_and_info2', {
          ticker,
          paymentId,
          expectedAssetId: expectedAssetId || undefined,
          transfersCount: transfers.length,
          matchesCount: byHash.size
        });
      } else {
        watcherLogger.warn('Fallback get_recent_txs_and_info2 failed', {
          ticker,
          paymentId,
          expectedAssetId: expectedAssetId || undefined,
          statusCode: recentResp.status,
          errorMessage: recentResp.data?.error?.message
        });
      }
    } catch (err) {
      watcherLogger.warn('Fallback get_recent_txs_and_info2 error', {
        ticker,
        paymentId,
        error: err.message
      });
    }
  }

  const matches = Array.from(byHash.values());

  watcherLogger.debug('RPC deposits (get_payments + get_wallet_info)', {
    ticker,
    count: matches.length,
    hasPaymentId: Boolean(paymentId),
    currentHeight,
    paymentIdsReturned: payments.length,
    confirmationsByHash: matches.map((m) => ({ hash: m.hash, confirmations: m.confirmations }))
  });

  return matches;
};

const fetchDeposits = async (address, ticker, config, paymentId) => {
  if (config.zanoStatusUrl) {
    try {
      const deposits = await fetchViaStatusApi(address, ticker, config);
      if (deposits.length > 0) {
        watcherLogger.debug('Status API deposits', { ticker, count: deposits.length });
        return deposits;
      }
    } catch (error) {
      // fall back to RPC if status API is unavailable
      watcherLogger.warn('Status API error, falling back to RPC:', error.message);
    }
  }

  const rpcDeposits = await fetchViaRpc(address, ticker, config, paymentId);
  watcherLogger.debug('RPC deposits', { ticker, count: rpcDeposits.length, hasPaymentId: Boolean(paymentId) });
  return rpcDeposits;
};

const sendWebhook = async (payload, config) => {
  const ticker = normalizeTicker(payload?.ticker || '');
  const url = (config.webhookUrls?.[ticker] || config.webhookUrl || '').trim();
  if (!url) {
    return { ok: false, error: 'Webhook URL is not configured', statusCode: null };
  }

  try {
    const response = await axios.post(url, payload, {
      timeout: config.webhookTimeoutMs,
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        'X-Zano-Secret': config.webhookSecret
      }
    });

    if (response.status >= 200 && response.status < 300) {
      watcherLogger.debug('Webhook delivered', { status: response.status, paymentId: payload.paymentId });
      return { ok: true, error: '', statusCode: response.status };
    }

    const errorText = truncateText(
      `HTTP ${response.status}: ${
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {})
      }`,
      500
    );
    watcherLogger.error('Webhook failed', response.status, response.data);
    return { ok: false, error: errorText, statusCode: response.status };
  } catch (error) {
    watcherLogger.warn('Webhook request error', {
      paymentId: payload?.paymentId,
      error: error.message
    });
    return { ok: false, error: truncateText(error.message || 'request error', 500), statusCode: null };
  }
};

const handleJob = async (kv, key, ticker, config) => {
  const job = await getDepositJob(kv, key);
  if (!job || !job.address || !job.txId) {
    await deleteDepositJob(kv, key);
    return;
  }

  let minConfirmations = asNumber(job.minConf, config.minConfirmations[ticker] || 0);
  const decimals = asNumber(config.decimals?.[ticker], config.decimals?.zano ?? 12);

  // Backfill paymentId if it wasn't stored in the hash (older jobs)
  let paymentId = job.paymentId;
  if (!paymentId) {
    try {
      const status = await readStatus(kv, ticker, job.txId, config.keyPrefix);
      paymentId = status?.paymentId || '';
      if (paymentId) {
        await kv.hset(key, { paymentId });
        watcherLogger.info('Backfilled paymentId onto job', { key, ticker });
      } else {
        watcherLogger.debug('No paymentId found in status for backfill', {
          key,
          ticker,
          keyPrefix: config.keyPrefix
        });
      }
    } catch (err) {
      watcherLogger.warn('Failed to backfill paymentId', { key, ticker, error: err.message });
    }
  }

  watcherLogger.debug('Handling job', {
    key,
    ticker,
    paymentId: paymentId || job.txId,
    address: job.address,
    minConfirmations
  });

  if (!paymentId) {
    watcherLogger.warn('Skipping RPC fetch; paymentId missing after backfill attempt', {
      key,
      ticker,
      txId: job.txId
    });
  }

  const deposits = await fetchDeposits(job.address, ticker, config, paymentId || '');
  if (!Array.isArray(deposits) || deposits.length === 0) {
    watcherLogger.debug('No deposits yet', { key, ticker });
    return;
  }

  const best = deposits
    .slice()
    .sort((a, b) => asNumber(b.confirmations, 0) - asNumber(a.confirmations, 0))[0];

  if (best && best.hash) {
    const expectedAssetId = (config.assetIds?.[ticker] || '').trim();
    try {
      await persistDepositLedgerFirstSeen(
        kv,
        ticker,
        best.hash,
        {
          paymentId: job.paymentId || job.txId,
          clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
          amountAtomic: best.amountAtomic,
          assetId: expectedAssetId || undefined
        },
        config
      );
    } catch (err) {
      watcherLogger.debug('Failed to persist deposit ledger entry', {
        key,
        ticker,
        hash: best.hash,
        error: err.message
      });
    }
  }

  const dynamicMinConfirmations =
    best && best.amountAtomic !== undefined
      ? computeDynamicMinConfirmations(best.amountAtomic, decimals)
      : null;

  if (dynamicMinConfirmations !== null) {
    let existingStatus = null;
    try {
      existingStatus = await readStatus(kv, ticker, job.txId, config.keyPrefix);
    } catch (err) {
      watcherLogger.debug('Failed to read existing status for dynamic minConf', {
        key,
        ticker,
        error: err.message
      });
    }

    const statusValue = String(existingStatus?.status || 'PENDING').toUpperCase();
    const dynamicAlreadyApplied =
      String(job.dynamicMinConfApplied || '').toLowerCase() === 'true';
    if (!dynamicAlreadyApplied && statusValue !== 'COMPLETED') {
      if (dynamicMinConfirmations !== minConfirmations) {
        minConfirmations = dynamicMinConfirmations;
        try {
          await kv.hset(key, {
            minConf: String(dynamicMinConfirmations),
            dynamicMinConfApplied: true
          });
        } catch (err) {
          watcherLogger.warn('Failed to persist dynamic min confirmations', {
            key,
            ticker,
            error: err.message
          });
        }
        watcherLogger.info('Dynamic confirmations applied', {
          key,
          ticker,
          amountAtomic: best.amountAtomic,
          dynamicMinConfirmations
        });
      }
    }
  }

  const confirmed = deposits
    .filter((d) => asNumber(d.confirmations, 0) >= minConfirmations)
    .sort((a, b) => asNumber(b.confirmations, 0) - asNumber(a.confirmations, 0))[0];

  if (!confirmed || !confirmed.hash) {
    // If we saw deposits but none meet the threshold, publish a confirming status
    if (best && best.hash) {
      watcherLogger.info('Deposit seen but below confirmations threshold', {
        key,
        ticker,
        hash: best.hash,
        confirmations: best.confirmations,
        minConfirmations
      });
      try {
        await saveStatus(
          kv,
          ticker,
          job.txId,
          {
            status: 'CONFIRMING',
            address: job.address,
            confirmations: asNumber(best.confirmations, 0),
            hash: best.hash,
            paymentId: job.paymentId || job.txId,
            clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
            createdAt: job.createdAt || undefined,
            minConfirmations,
            requiredConfirmations: minConfirmations
          },
          { ttlSeconds: config.statusTtlSeconds, keyPrefix: config.keyPrefix }
        );
      } catch (err) {
        watcherLogger.warn('Failed to write CONFIRMING status', { key, ticker, error: err.message });
      }
    } else {
      watcherLogger.debug('No confirmed deposit meets threshold', { key, ticker, minConfirmations });
    }
    return;
  }

  watcherLogger.info('Confirmed deposit found', {
    key,
    ticker,
    hash: confirmed.hash,
    confirmations: confirmed.confirmations,
    amountAtomic: confirmed.amountAtomic
  });
  const webhookSent = String(job.webhookSent || '').toLowerCase() === 'true';
  const webhookAttempts = asNumber(job.webhookAttempts, 0);
  const webhookNextAttemptAt = asNumber(job.webhookNextAttemptAt, 0);
  const webhookFirstAttemptAt = asNumber(job.webhookFirstAttemptAt, 0);

  if (await isSeen(kv, confirmed.hash, config.keyPrefix)) {
    watcherLogger.info('Deposit already seen, deleting job', {
      key,
      hash: confirmed.hash,
      ticker
    });
    await deleteDepositJob(kv, key);
    return;
  }

  const amountAtomic = confirmed.amountAtomic ?? confirmed.amount ?? '';
  const payload = {
    paymentId: job.txId,
    address: job.address,
    amount: formatAtomicAmount(amountAtomic, decimals) || '',
    amountAtomic: String(amountAtomic),
    paidAmount: formatAtomicAmount(amountAtomic, decimals) || '',
    paidAmountAtomic: String(amountAtomic),
    effectiveAmount: formatAtomicAmount(amountAtomic, decimals) || '',
    effectiveAmountAtomic: String(amountAtomic),
    feeAtomic: null,
    confirmations: asNumber(confirmed.confirmations, 0),
    hash: confirmed.hash,
    ticker,
    clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
    createdAt: job.createdAt || undefined
  };

  let webhookOk = true;
  if (!webhookSent) {
    // We've reached the confirmation threshold, but completion requires a successful webhook.
    // Keep status fresh (especially when requiredConfirmations is low) so clients can see up-to-date confirmations.
	    try {
	      await saveStatus(
	        kv,
	        ticker,
	        job.txId,
	        {
	          status: 'CONFIRMING',
	          address: job.address,
	          confirmations: asNumber(confirmed.confirmations, 0),
	          requiredConfirmations: minConfirmations,
	          hash: confirmed.hash,
	          paymentId: job.paymentId || job.txId,
	          clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
	          createdAt: job.createdAt || undefined
	        },
	        { ttlSeconds: config.statusTtlSeconds, keyPrefix: config.keyPrefix }
	      );
	    } catch (err) {
	      watcherLogger.warn('Failed to refresh CONFIRMING status before webhook', { key, ticker, error: err.message });
    }

    const now = Date.now();
    const maxAttempts = asNumber(config.webhookMaxAttempts, 0);
    const maxRetryWindowMs = asNumber(config.webhookMaxRetryWindowMs, 2 * 60 * 60 * 1000);

    if (maxRetryWindowMs > 0 && webhookFirstAttemptAt && now - webhookFirstAttemptAt > maxRetryWindowMs) {
      watcherLogger.warn('Webhook retry window exceeded; failing job', {
        key,
        ticker,
        paymentId: payload.paymentId,
        webhookAttempts,
        webhookFirstAttemptAt,
        maxRetryWindowMs
      });

      const lastError = truncateText(job.webhookLastError || 'webhook retry window exceeded', 500);
      try {
        await saveStatus(
          kv,
          ticker,
          job.txId,
          {
            status: 'FAILED',
            address: job.address,
            confirmations: asNumber(confirmed.confirmations, 0),
            requiredConfirmations: minConfirmations,
            hash: confirmed.hash,
            paymentId: job.paymentId || job.txId,
            clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
            createdAt: job.createdAt || undefined,
            webhookError: lastError
          },
          { ttlSeconds: config.statusTtlSeconds, keyPrefix: config.keyPrefix }
        );
      } catch (err) {
        watcherLogger.warn('Failed to save FAILED status after retry window exceeded', {
          key,
          ticker,
          error: err.message
        });
      }

      await markSeen(kv, confirmed.hash, config.seenTtlSeconds, config.keyPrefix);
      await deleteDepositJob(kv, key);
      return;
    }
    if (maxAttempts > 0 && webhookAttempts >= maxAttempts) {
      webhookOk = false;
      watcherLogger.warn('Webhook max attempts reached; skipping webhook', {
        key,
        ticker,
        paymentId: payload.paymentId,
        webhookAttempts,
        webhookNextAttemptAt
      });
      return;
    } else if (webhookNextAttemptAt && now < webhookNextAttemptAt) {
      webhookOk = false;
      watcherLogger.debug('Webhook in backoff window, skipping', {
        key,
        ticker,
        paymentId: payload.paymentId,
        webhookAttempts,
        webhookNextAttemptAt
      });
      return;
    } else {
      const startedAt = Date.now();
      const webhookResult = await sendWebhook(payload, config);
      webhookOk = Boolean(webhookResult?.ok);
      payload.__webhookError = webhookResult?.error || '';
      try {
        await persistDepositLedgerWebhookResult(
          kv,
          ticker,
          confirmed.hash,
          {
            attemptedAt: startedAt,
            ok: webhookOk,
            statusCode: webhookResult?.statusCode,
            error: webhookResult?.error,
            attempts: webhookAttempts + 1
          },
          config
        );
      } catch (err) {
        watcherLogger.debug('Failed to persist webhook result to deposit ledger', {
          key,
          ticker,
          hash: confirmed.hash,
          error: err.message
        });
      }
    }
    if (webhookOk) {
      try {
        await saveStatus(
          kv,
          ticker,
          job.txId,
          {
            status: 'COMPLETED',
            address: job.address,
            confirmations: asNumber(confirmed.confirmations, 0),
            requiredConfirmations: minConfirmations,
            hash: confirmed.hash,
            paymentId: job.paymentId || job.txId,
            clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
            paidAmount: formatAtomicAmount(confirmed.amountAtomic ?? confirmed.amount ?? '', decimals) || '',
            paidAmountAtomic: String(confirmed.amountAtomic ?? confirmed.amount ?? ''),
            effectiveAmount: payload.effectiveAmount || payload.amount,
            effectiveAmountAtomic: payload.effectiveAmountAtomic || payload.amountAtomic,
            feeAtomic: payload.feeAtomic || undefined
          },
          { ttlSeconds: config.statusTtlSeconds, keyPrefix: config.keyPrefix }
        );
      } catch (err) {
        watcherLogger.warn('Failed to save COMPLETED status', { key, ticker, error: err.message });
      }

      await kv.hset(key, {
        webhookSent: true,
        webhookAttempts: '0',
        webhookNextAttemptAt: '',
        webhookLastAttemptAt: '',
        webhookLastError: ''
      });
      watcherLogger.info('Webhook sent and marked as completed', {
        key,
        hash: confirmed.hash,
        ticker,
        paymentId: payload.paymentId
      });
    } else {
      const attemptedNow = !webhookNextAttemptAt || now >= webhookNextAttemptAt;
      const shouldRecordFailure = attemptedNow && !(maxAttempts > 0 && webhookAttempts >= maxAttempts);

      if (shouldRecordFailure) {
        const attempts = webhookAttempts + 1;
        const delayMs = computeWebhookBackoffDelayMs(attempts, config);
        const nextAttemptAt = now + delayMs;
        const lastError = truncateText(payload.__webhookError || 'webhook attempt failed', 500);

        const firstAttemptAt = webhookFirstAttemptAt || now;

        try {
          await kv.hset(key, {
            webhookAttempts: String(attempts),
            webhookFirstAttemptAt: String(firstAttemptAt),
            webhookLastAttemptAt: String(now),
            webhookNextAttemptAt: String(nextAttemptAt),
            webhookLastError: lastError
          });
        } catch (err) {
          watcherLogger.warn('Failed to persist webhook retry state', { key, ticker, error: err.message });
        }

        watcherLogger.warn('Webhook attempt failed; backing off', {
          key,
          ticker,
          paymentId: payload.paymentId,
          webhookAttempts: attempts,
          nextAttemptAt,
          delayMs
        });
      }

      // Webhook failed; keep status in a non-completed state while we retry.
	      try {
	        await saveStatus(
	          kv,
	          ticker,
	          job.txId,
	          {
	            status: 'CONFIRMING',
	            address: job.address,
	            confirmations: asNumber(confirmed.confirmations, 0),
	            requiredConfirmations: minConfirmations,
	            hash: confirmed.hash,
	            paymentId: job.paymentId || job.txId,
	            clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
	            createdAt: job.createdAt || undefined
	          },
	          { ttlSeconds: config.statusTtlSeconds, keyPrefix: config.keyPrefix }
	        );
	      } catch (err) {
	        watcherLogger.warn('Failed to refresh CONFIRMING status after webhook failure', { key, ticker, error: err.message });
	      }
      watcherLogger.warn('Webhook not accepted, job retained', {
        key,
        hash: confirmed.hash,
        ticker,
        paymentId: payload.paymentId,
        webhookAttempts,
        webhookNextAttemptAt
      });
    }
  }

  if (webhookOk) {
    await markSeen(kv, confirmed.hash, config.seenTtlSeconds, config.keyPrefix);
    await deleteDepositJob(kv, key);
  }
};

const processTickerJobs = async (kv, ticker, config) => {
  let cursor = '0';
  const pattern = `${config.keyPrefix}:deposit:${ticker}:*`;

  do {
    const { cursor: nextCursor, keys } = await kv.scan(pattern, config.scanCount, cursor);
    watcherLogger.debug('Scanning jobs', { ticker, batchSize: keys.length, cursor });
    for (const key of keys) {
      try {
        await handleJob(kv, key, ticker, config);
      } catch (error) {
        if (error.isRpcError) {
          throw error;
        }
        watcherLogger.error(`Failed to handle job ${key}:`, error.message);
      }
    }
    cursor = nextCursor;
  } while (cursor !== '0');
};

const startDepositWatcher = (kv, config) => {
  watcherLogger = createLogger(config.logLevel, config.logErrorFile);

  if (!config.enabled || !config.tickers || config.tickers.length === 0) {
    watcherLogger.info('Deposit watcher disabled (no tickers configured).');
    return;
  }

  if (!kv || !config.kvReady) {
    watcherLogger.info('Deposit watcher disabled (KV not configured).');
    return;
  }

  const hasAnyWebhookUrl =
    Boolean((config.webhookUrl || '').trim()) ||
    (config.webhookUrls && Object.values(config.webhookUrls).some((v) => Boolean((v || '').trim())));

  if (!hasAnyWebhookUrl || !config.webhookSecret) {
    watcherLogger.info(
      'Deposit watcher disabled (missing webhook url or WATCHER_SHARED_SECRET).'
    );
    return;
  }

  const backoffUntil = new Map();
  const state = { running: true };

  const loop = async () => {
    if (!state.running) return;

    const started = Date.now();
    for (const tickerRaw of config.tickers) {
      const ticker = normalizeTicker(tickerRaw);
      const until = backoffUntil.get(ticker) || 0;
      if (until > Date.now()) {
        watcherLogger.debug('Ticker in backoff window, skipping', { ticker, resumeAt: until });
        continue;
      }

      try {
        watcherLogger.debug('Processing ticker', { ticker });
        await processTickerJobs(kv, ticker, config);
      } catch (error) {
        if (error.isRpcError) {
          backoffUntil.set(ticker, Date.now() + (config.errorBackoffMs || 30000));
          watcherLogger.warn(`RPC error for ${ticker}, backing off:`, error.message);
        } else {
          watcherLogger.error(`Watcher error for ${ticker}:`, error.message);
        }
      }
    }

    const elapsed = Date.now() - started;
    const delay = Math.max(config.intervalMs - elapsed, 1000);
    watcherLogger.debug('Watcher loop complete', { elapsedMs: elapsed, nextDelayMs: delay });
    setTimeout(loop, delay);
  };

  watcherLogger.info(
    `Deposit watcher started for tickers [${config.tickers.join(
      ', '
    )}] - interval ${config.intervalMs}ms, scan count ${config.scanCount}, log level ${config.logLevel}`
  );

  loop();
  return () => {
    state.running = false;
    watcherLogger.info('Deposit watcher stopped');
  };
};

module.exports = {
  startDepositWatcher
};
