const axios = require('axios');
const {
  getDepositJob,
  deleteDepositJob,
  markSeen,
  isSeen,
  formatAtomicAmount
} = require('./deposits');
const { normalizeTicker } = require('./watcher-config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const fetchViaRpc = async (address, ticker, config) => {
  if (!config.zanoRpcUrl) return [];

  const payload = {
    jsonrpc: '2.0',
    id: `watcher-${Date.now()}`,
    method: 'get_transfers',
    params: {
      filter_by_addresses: [address],
      in: true,
      out: false
    }
  };

  const response = await axios.post(config.zanoRpcUrl, payload, {
    auth: config.zanoRpcUser
      ? {
          username: config.zanoRpcUser,
          password: config.zanoRpcPassword || ''
        }
      : undefined,
    timeout: Math.max(config.webhookTimeoutMs, 10000),
    validateStatus: () => true
  });

  if (response.status >= 400 || response.data?.error) {
    throw rpcError(
      `Zano RPC error ${response.status}: ${response.data?.error?.message || 'unknown'}`,
      response.data
    );
  }

  return normalizeDeposits(response.data?.result || response.data, address, ticker);
};

const consolidateDeposit = async (ticker, deposit, config) => {
  const rules = config.consolidation?.[ticker] || {};
  if (!rules.enabled || !rules.address) return null;

  const payload = {
    jsonrpc: '2.0',
    id: `consolidate-${Date.now()}`,
    method: 'transfer',
    params: {
      destinations: [
        {
          address: rules.address,
          amount: Number(deposit.amountAtomic || deposit.amount || 0)
        }
      ],
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

  return response.data?.result || response.data;
};

const fetchDeposits = async (address, ticker, config) => {
  if (config.zanoStatusUrl) {
    try {
      const deposits = await fetchViaStatusApi(address, ticker, config);
      if (deposits.length > 0) {
        return deposits;
      }
    } catch (error) {
      // fall back to RPC if status API is unavailable
      console.error('Status API error, falling back to RPC:', error.message);
    }
  }

  return fetchViaRpc(address, ticker, config);
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
    return true;
  }

  console.error('Webhook failed', response.status, response.data);
  return false;
};

const handleJob = async (kv, key, ticker, config) => {
  const job = await getDepositJob(kv, key);
  if (!job || !job.address || !job.txId) {
    await deleteDepositJob(kv, key);
    return;
  }

  const minConfirmations = asNumber(job.minConf, config.minConfirmations[ticker] || 0);

  const deposits = await fetchDeposits(job.address, ticker, config);
  if (!Array.isArray(deposits) || deposits.length === 0) {
    return;
  }

  const confirmed = deposits
    .filter((d) => asNumber(d.confirmations, 0) >= minConfirmations)
    .sort((a, b) => asNumber(b.confirmations, 0) - asNumber(a.confirmations, 0))[0];

  if (!confirmed || !confirmed.hash) {
    return;
  }

  if (await isSeen(kv, confirmed.hash)) {
    await deleteDepositJob(kv, key);
    return;
  }

  const decimals = config.decimals[ticker] || 12;
  const amountAtomic = confirmed.amountAtomic ?? confirmed.amount ?? '';
  const payload = {
    jobId: job.jobId || job.txId,
    txId: job.txId,
    address: job.address,
    amount: formatAtomicAmount(amountAtomic, decimals) || '',
    amountAtomic: String(amountAtomic),
    expectedAmount: job.expectedAmount || undefined,
    confirmations: asNumber(confirmed.confirmations, 0),
    hash: confirmed.hash,
    ticker,
    sessionId: job.sessionId || undefined,
    createdAt: job.createdAt || undefined
  };

  let consolidationResult = null;
  try {
    consolidationResult = await consolidateDeposit(ticker, confirmed, config);
    if (consolidationResult?.tx_hash) {
      payload.consolidationTxId = consolidationResult.tx_hash;
    }
  } catch (error) {
    console.error(`Consolidation failed for ${key}:`, error.message);
    throw error;
  }

  const ok = await sendWebhook(payload, config);
  if (ok) {
    await markSeen(kv, confirmed.hash, config.seenTtlSeconds);
    await deleteDepositJob(kv, key);
  }
};

const processTickerJobs = async (kv, ticker, config) => {
  let cursor = '0';
  const pattern = `deposit:${ticker}:*`;

  do {
    const { cursor: nextCursor, keys } = await kv.scan(pattern, config.scanCount, cursor);
    for (const key of keys) {
      try {
        await handleJob(kv, key, ticker, config);
      } catch (error) {
        if (error.isRpcError) {
          throw error;
        }
        console.error(`Failed to handle job ${key}:`, error.message);
      }
    }
    cursor = nextCursor;
  } while (cursor !== '0');
};

const startDepositWatcher = (kv, config) => {
  if (!config.enabled || !config.tickers || config.tickers.length === 0) {
    console.log('Deposit watcher disabled (no tickers configured).');
    return;
  }

  if (!kv || !config.kvReady) {
    console.log('Deposit watcher disabled (KV not configured).');
    return;
  }

  if (!config.webhookUrl || !config.webhookSecret) {
    console.log('Deposit watcher disabled (missing WATCHER_WEBHOOK_URL or WATCHER_SHARED_SECRET).');
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
        continue;
      }

      try {
        await processTickerJobs(kv, ticker, config);
      } catch (error) {
        if (error.isRpcError) {
          backoffUntil.set(ticker, Date.now() + (config.errorBackoffMs || 30000));
          console.error(`RPC error for ${ticker}, backing off:`, error.message);
        } else {
          console.error(`Watcher error for ${ticker}:`, error.message);
        }
      }
    }

    const elapsed = Date.now() - started;
    const delay = Math.max(config.intervalMs - elapsed, 1000);
    setTimeout(loop, delay);
  };

  console.log(
    `Deposit watcher started for tickers [${config.tickers.join(
      ', '
    )}] - interval ${config.intervalMs}ms, scan count ${config.scanCount}`
  );

  loop();
  return () => {
    state.running = false;
  };
};

module.exports = {
  startDepositWatcher
};
