const { normalizeTicker } = require('./watcher-config');

const DEFAULT_PREFIX = process.env.WATCHER_KEY_PREFIX || 'zano';

const buildJobKey = (ticker, id, prefix = DEFAULT_PREFIX) =>
  `${prefix}:deposit:${normalizeTicker(ticker)}:${id}`;
const buildSeenKey = (hash, prefix = DEFAULT_PREFIX) => `${prefix}:seen:${hash}`;
const buildStatusKey = (ticker, txId, prefix = DEFAULT_PREFIX) =>
  `${prefix}:transaction:status:${normalizeTicker(ticker)}:${txId}`;

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
    sessionUUID: data.sessionUUID || '',
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

module.exports = {
  buildJobKey,
  buildSeenKey,
  buildStatusKey,
  createDepositJob,
  getDepositJob,
  deleteDepositJob,
  markSeen,
  isSeen,
  saveStatus,
  readStatus,
  formatAtomicAmount,
  toBigInt
};
