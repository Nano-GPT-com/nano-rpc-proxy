const axios = require('axios');
const {
  getDepositJob,
  deleteDepositJob,
  markSeen,
  isSeen,
  readStatus,
  formatAtomicAmount
} = require('./deposits');
const { normalizeTicker } = require('./watcher-config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const createLogger = (level = 'info') => {
  const current = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const prefix = '[watcher]';
  const should = (lvl) => (LOG_LEVELS[lvl] ?? LOG_LEVELS.info) <= current;

  return {
    error: (...args) => should('error') && console.error(prefix, ...args),
    warn: (...args) => should('warn') && console.warn(prefix, ...args),
    info: (...args) => should('info') && console.log(prefix, ...args),
    debug: (...args) => should('debug') && console.debug(prefix, ...args)
  };
};

let watcherLogger = createLogger(process.env.WATCHER_LOG_LEVEL || 'info');

const asNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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

  const currentHeight = asNumber(heightResp.data?.result?.current_height, 0);

  // Then: get payments (returns block_height)
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

  const payments = payResp.data?.result?.payments || [];

  const matches = payments.map((p) => {
    const height = asNumber(p.block_height, 0);
    const confirmations =
      height > 0 && currentHeight > 0 ? Math.max(currentHeight - height, 0) : asNumber(p.confirmations, 0);
    return {
      hash: p.tx_hash,
      amountAtomic: p.amount,
      confirmations,
      address,
      ticker
    };
  });

  watcherLogger.debug('RPC deposits (get_payments + get_height)', {
    ticker,
    count: matches.length,
    hasPaymentId: Boolean(paymentId),
    currentHeight,
    paymentIdsReturned: payments.length
  });

  return matches;
};

const consolidateDeposit = async (ticker, deposit, config) => {
  const rules = config.consolidation?.[ticker] || {};
  if (!rules.enabled || !rules.address) {
    watcherLogger.debug('Consolidation skipped (disabled or address missing)', {
      ticker,
      enabled: rules.enabled,
      hasAddress: Boolean(rules.address)
    });
    return null;
  }

  const fee = Number.isFinite(rules.feeAtomic) ? rules.feeAtomic : 10000000000;
  const amountAtomic = Number(deposit.amountAtomic || deposit.amount || 0);
  const sendAmount = amountAtomic - fee;

  if (sendAmount <= 0) {
    watcherLogger.warn('Consolidation skipped (amount <= fee)', {
      ticker,
      amountAtomic,
      fee
    });
    return null;
  }

  const payload = {
    jsonrpc: '2.0',
    id: `consolidate-${Date.now()}`,
    method: 'transfer',
    params: {
      destinations: [
        {
          address: rules.address,
          amount: sendAmount
        }
      ],
      fee,
      mixin: 3,
      unlock_time: 0,
      do_not_relay: false,
      priority: 0
    }
  };

  const response = await axios.post(config.zanoRpcUrl, payload, {
    auth: config.zanoRpcUser
      ? {
          username: config.zanoRpcUser,
          password: config.zanoRpcPassword || ''
        }
      : undefined,
    timeout: Math.max(config.webhookTimeoutMs, 20000),
    validateStatus: () => true
  });

  if (response.status >= 400 || response.data?.error) {
    throw rpcError(
      `Consolidation transfer failed ${response.status}: ${response.data?.error?.message || 'unknown'}`,
      response.data
    );
  }

  watcherLogger.debug('Consolidation transfer submitted', {
    ticker,
    amountAtomic: deposit.amountAtomic,
    fee
  });

  return response.data?.result || response.data;
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
  const response = await axios.post(config.webhookUrl, payload, {
    timeout: config.webhookTimeoutMs,
    validateStatus: () => true,
    headers: {
      'Content-Type': 'application/json',
      'X-Zano-Secret': config.webhookSecret
    }
  });

  if (response.status >= 200 && response.status < 300) {
    watcherLogger.debug('Webhook delivered', { status: response.status, txId: payload.txId });
    return true;
  }

  watcherLogger.error('Webhook failed', response.status, response.data);
  return false;
};

const handleJob = async (kv, key, ticker, config) => {
  const job = await getDepositJob(kv, key);
  if (!job || !job.address || !job.txId) {
    await deleteDepositJob(kv, key);
    return;
  }

  const minConfirmations = asNumber(job.minConf, config.minConfirmations[ticker] || 0);

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
    txId: job.txId,
    address: job.address,
    paymentId,
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

  const confirmed = deposits
    .filter((d) => asNumber(d.confirmations, 0) >= minConfirmations)
    .sort((a, b) => asNumber(b.confirmations, 0) - asNumber(a.confirmations, 0))[0];

  if (!confirmed || !confirmed.hash) {
    // If we saw deposits but none meet the threshold, publish a confirming status
    const best = deposits.sort(
      (a, b) => asNumber(b.confirmations, 0) - asNumber(a.confirmations, 0)
    )[0];
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
            expectedAmount: job.expectedAmount || '',
            confirmations: asNumber(best.confirmations, 0),
            hash: best.hash,
            paymentId: job.paymentId || job.txId,
            clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
            createdAt: job.createdAt || undefined
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

  if (await isSeen(kv, confirmed.hash, config.keyPrefix)) {
    watcherLogger.info('Deposit already seen, deleting job', {
      key,
      hash: confirmed.hash,
      ticker
    });
    await deleteDepositJob(kv, key);
    return;
  }

  const decimals = config.decimals[ticker] || 12;
  const amountAtomic = confirmed.amountAtomic ?? confirmed.amount ?? '';
  const payload = {
    paymentId: job.txId,
    address: job.address,
    amount: formatAtomicAmount(amountAtomic, decimals) || '',
    amountAtomic: String(amountAtomic),
    expectedAmount: job.expectedAmount || undefined,
    confirmations: asNumber(confirmed.confirmations, 0),
    hash: confirmed.hash,
    ticker,
    clientReference: job.clientReference || job.sessionUUID || job.sessionId || undefined,
    createdAt: job.createdAt || undefined
  };

  const consolidationAttempted = String(job.consolidationAttempted || '').toLowerCase() === 'true';

  let consolidationResult = null;
  let consolidationError = null;

  if (consolidationAttempted) {
    watcherLogger.debug('Skipping consolidation (already attempted)', { key, ticker });
  } else {
    try {
      consolidationResult = await consolidateDeposit(ticker, confirmed, config);
      if (consolidationResult?.tx_hash) {
        payload.consolidationTxId = consolidationResult.tx_hash;
        watcherLogger.info('Consolidation completed', {
          key,
          ticker,
          consolidationTxId: consolidationResult.tx_hash
        });
      }
      await kv.hset(key, {
        consolidationAttempted: true,
        consolidationTxId: consolidationResult?.tx_hash || ''
      });
    } catch (error) {
      consolidationError = error.message || 'unknown error';
      watcherLogger.error(`Consolidation failed for ${key}:`, consolidationError);
      await kv.hset(key, {
        consolidationAttempted: true,
        consolidationError
      });
    }
  }

  if (consolidationError) {
    payload.consolidationError = consolidationError;
  }

  const ok = await sendWebhook(payload, config);
  if (ok) {
    watcherLogger.info('Webhook sent and job completed', {
      key,
      hash: confirmed.hash,
      ticker,
      paymentId: payload.paymentId
    });
    await markSeen(kv, confirmed.hash, config.seenTtlSeconds, config.keyPrefix);
    await deleteDepositJob(kv, key);
  } else {
    watcherLogger.warn('Webhook not accepted, job retained', {
      key,
      hash: confirmed.hash,
      ticker,
      paymentId: payload.paymentId
    });
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
  watcherLogger = createLogger(config.logLevel);

  if (!config.enabled || !config.tickers || config.tickers.length === 0) {
    watcherLogger.info('Deposit watcher disabled (no tickers configured).');
    return;
  }

  if (!kv || !config.kvReady) {
    watcherLogger.info('Deposit watcher disabled (KV not configured).');
    return;
  }

  if (!config.webhookUrl || !config.webhookSecret) {
    watcherLogger.info('Deposit watcher disabled (missing WATCHER_WEBHOOK_URL or WATCHER_SHARED_SECRET).');
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
