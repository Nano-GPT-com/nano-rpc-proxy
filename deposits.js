const { normalizeTicker } = require('./watcher-config');

const DEFAULT_PREFIX = process.env.WATCHER_KEY_PREFIX || 'zano';

const buildJobKey = (ticker, id, prefix = DEFAULT_PREFIX) =>
  `${prefix}:deposit:${normalizeTicker(ticker)}:${id}`;
const buildSeenKey = (hash, prefix = DEFAULT_PREFIX) => `${prefix}:seen:${hash}`;
const buildStatusKey = (ticker, txId, prefix = DEFAULT_PREFIX) =>
  `${prefix}:transaction:status:${normalizeTicker(ticker)}:${txId}`;
const buildDepositLedgerKey = (ticker, hash, prefix = DEFAULT_PREFIX) =>
  `${prefix}:deposit:ledger:${normalizeTicker(ticker)}:${hash}`;

const toBigInt = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch (_) {
      return null;
    }
  }
  return null;
};

const formatAtomicAmount = (value, decimals) => {
  const atomic = toBigInt(value);
  if (atomic === null) return null;

  const scale = BigInt(10) ** BigInt(decimals);
  const integer = atomic / scale;
  const fraction = atomic % scale;

  if (fraction === BigInt(0)) {
    return integer.toString();
  }

  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${integer.toString()}.${fractionStr}`;
};

const ensureTimestamp = (value) => {
  if (!value) return new Date().toISOString();
  return value;
};

const createDepositJob = async (kv, data, { ttlSeconds, defaultMinConf, keyPrefix } = {}) => {
  const ticker = normalizeTicker(data.ticker);
  const id = data.paymentId || data.txId;
  const prefix = keyPrefix || DEFAULT_PREFIX;

  if (!ticker || !id || !data.address) {
    throw new Error('ticker, address, and paymentId are required to create a deposit job');
  }

  const key = buildJobKey(ticker, id, prefix);
  const payload = {
    ticker,
    address: data.address,
    txId: id,
    expectedAmount: data.expectedAmount ?? '',
    minConf: data.minConf || defaultMinConf || '',
    clientReference: data.clientReference || data.sessionUUID || '',
    paymentId: data.paymentId || data.txId || '',
    createdAt: ensureTimestamp(data.createdAt)
  };

  await kv.hset(key, payload);

  if (ttlSeconds && Number.isFinite(ttlSeconds)) {
    await kv.expire(key, ttlSeconds);
  }

  return { key, payload };
};

const getDepositJob = async (kv, key) => kv.hgetall(key);

const deleteDepositJob = async (kv, key) => kv.del(key);

const markSeen = async (kv, hash, ttlSeconds, prefix = DEFAULT_PREFIX) =>
  kv.set(buildSeenKey(hash, prefix), '1', { ttlSeconds });

const isSeen = async (kv, hash, prefix = DEFAULT_PREFIX) => kv.exists(buildSeenKey(hash, prefix));

const saveStatus = async (kv, ticker, txId, status, { ttlSeconds, keyPrefix } = {}) => {
  const key = buildStatusKey(ticker, txId, keyPrefix || DEFAULT_PREFIX);
  const payload = {
    ...status,
    ticker: normalizeTicker(ticker),
    updatedAt: new Date().toISOString()
  };

  await kv.setJson(key, payload, { ttlSeconds });
  return payload;
};

const readStatus = async (kv, ticker, txId, keyPrefix) =>
  kv.getJson(buildStatusKey(ticker, txId, keyPrefix || DEFAULT_PREFIX));

const upsertDepositLedgerFirstSeen = async (
  kv,
  ticker,
  hash,
  data,
  { ttlSeconds, keyPrefix } = {}
) => {
  const key = buildDepositLedgerKey(ticker, hash, keyPrefix || DEFAULT_PREFIX);
  const existing = await kv.hgetall(key);

  const patch = {};
  if (!existing || Object.keys(existing).length === 0) {
    patch.firstSeenAt = new Date().toISOString();
  } else if (!existing.firstSeenAt) {
    patch.firstSeenAt = new Date().toISOString();
  }

  if (!existing.paymentId && data?.paymentId) patch.paymentId = String(data.paymentId);
  if (!existing.clientReference && data?.clientReference) patch.clientReference = String(data.clientReference);
  if (!existing.amountAtomic && data?.amountAtomic !== undefined) patch.amountAtomic = String(data.amountAtomic);
  if (!existing.assetId && data?.assetId) patch.assetId = String(data.assetId);

  patch.lastSeenAt = new Date().toISOString();

  if (Object.keys(patch).length > 0) {
    await kv.hset(key, patch);
  }

  if (ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    await kv.expire(key, ttlSeconds);
  }

  return { key, patch };
};

const recordDepositLedgerWebhookResult = async (
  kv,
  ticker,
  hash,
  webhook,
  { ttlSeconds, keyPrefix } = {}
) => {
  const key = buildDepositLedgerKey(ticker, hash, keyPrefix || DEFAULT_PREFIX);
  const patch = {
    webhookLastAttemptAt: webhook?.attemptedAt ? String(webhook.attemptedAt) : String(Date.now()),
    webhookLastOk: webhook?.ok ? 'true' : 'false',
    webhookLastStatusCode:
      webhook?.statusCode === undefined || webhook?.statusCode === null
        ? ''
        : String(webhook.statusCode),
    webhookLastError: webhook?.error ? String(webhook.error) : '',
    webhookAttempts:
      webhook?.attempts === undefined || webhook?.attempts === null ? '' : String(webhook.attempts)
  };

  await kv.hset(key, patch);

  if (ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    await kv.expire(key, ttlSeconds);
  }

  return { key, patch };
};

module.exports = {
  buildJobKey,
  buildSeenKey,
  buildStatusKey,
  buildDepositLedgerKey,
  createDepositJob,
  getDepositJob,
  deleteDepositJob,
  markSeen,
  isSeen,
  saveStatus,
  readStatus,
  upsertDepositLedgerFirstSeen,
  recordDepositLedgerWebhookResult,
  formatAtomicAmount,
  toBigInt
};
