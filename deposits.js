const { normalizeTicker } = require('./watcher-config');

const buildJobKey = (ticker, jobId) => `deposit:${normalizeTicker(ticker)}:${jobId}`;
const buildSeenKey = (hash) => `deposit:seen:${hash}`;
const buildStatusKey = (ticker, txId) => `transaction:status:${normalizeTicker(ticker)}:${txId}`;

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

const createDepositJob = async (kv, data, { ttlSeconds, defaultMinConf }) => {
  const ticker = normalizeTicker(data.ticker);
  const jobId = data.jobId || data.txId;

  if (!ticker || !jobId || !data.address || !data.txId) {
    throw new Error('ticker, address, txId, and jobId are required to create a deposit job');
  }

  const key = buildJobKey(ticker, jobId);
  const payload = {
    ticker,
    address: data.address,
    txId: data.txId,
    jobId,
    expectedAmount: data.expectedAmount ?? '',
    minConf: data.minConf || defaultMinConf || '',
    sessionId: data.sessionId || '',
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

const markSeen = async (kv, hash, ttlSeconds) => kv.set(buildSeenKey(hash), '1', { ttlSeconds });

const isSeen = async (kv, hash) => kv.exists(buildSeenKey(hash));

const saveStatus = async (kv, ticker, txId, status, ttlSeconds) => {
  const key = buildStatusKey(ticker, txId);
  const payload = {
    ...status,
    ticker: normalizeTicker(ticker),
    txId,
    updatedAt: new Date().toISOString()
  };

  await kv.setJson(key, payload, { ttlSeconds });
  return payload;
};

const readStatus = async (kv, ticker, txId) => kv.getJson(buildStatusKey(ticker, txId));

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
