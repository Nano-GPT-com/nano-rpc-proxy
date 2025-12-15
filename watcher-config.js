const parseNumber = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseLogLevel = (value, fallback = 'info') => {
  const normalized = (value || fallback).toLowerCase();
  const allowed = ['error', 'warn', 'info', 'debug'];
  return allowed.includes(normalized) ? normalized : fallback;
};

const loadWatcherConfig = (overrides = {}) => {
  const tickers = (process.env.WATCHER_TICKERS || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const config = {
    tickers,
    intervalMs: parseNumber(process.env.WATCHER_INTERVAL_MS, 15000),
    scanCount: parseNumber(process.env.WATCHER_SCAN_COUNT, 100),
    webhookUrl: process.env.WATCHER_WEBHOOK_URL || '',
    webhookSecret: process.env.WATCHER_SHARED_SECRET || '',
    webhookTimeoutMs: parseNumber(process.env.WATCHER_WEBHOOK_TIMEOUT_MS, 10000),
    webhookBackoffBaseMs: parseNumber(process.env.WATCHER_WEBHOOK_BACKOFF_BASE_MS, 1000),
    webhookBackoffFactor: parseNumber(process.env.WATCHER_WEBHOOK_BACKOFF_FACTOR, 2),
    webhookBackoffMaxMs: parseNumber(process.env.WATCHER_WEBHOOK_BACKOFF_MAX_MS, 5 * 60 * 1000),
    webhookBackoffJitter: String(process.env.WATCHER_WEBHOOK_BACKOFF_JITTER || 'true').toLowerCase() === 'true',
    webhookMaxAttempts: parseNumber(process.env.WATCHER_WEBHOOK_MAX_ATTEMPTS, 0),
    seenTtlSeconds: parseNumber(process.env.WATCHER_SEEN_TTL_SECONDS, 4 * 60 * 60),
    jobTtlSeconds: parseNumber(process.env.WATCHER_JOB_TTL_SECONDS, 24 * 60 * 60),
    statusTtlSeconds: parseNumber(process.env.WATCHER_STATUS_TTL_SECONDS, 7 * 24 * 60 * 60),
    errorBackoffMs: parseNumber(process.env.WATCHER_ERROR_BACKOFF_MS, 30000),
    minConfirmations: {
      zano: parseNumber(process.env.WATCHER_MIN_CONFIRMATIONS_ZANO, 6),
      fusd: parseNumber(process.env.WATCHER_MIN_CONFIRMATIONS_FUSD, 2)
    },
    logLevel: parseLogLevel(process.env.WATCHER_LOG_LEVEL, 'info'),
    logErrorFile: process.env.WATCHER_LOG_ERROR_FILE || '',
    decimals: {
      zano: parseNumber(process.env.ZANO_DECIMALS, 12),
      fusd: parseNumber(process.env.FUSD_DECIMALS, 12)
    },
    kvUrl: process.env.KV_REST_API_URL || '',
    kvToken: process.env.KV_REST_API_TOKEN || '',
    zanoStatusUrl: overrides.zanoStatusUrl || process.env.ZANO_STATUS_URL || '',
    zanoRpcUrl: overrides.zanoRpcUrl || process.env.ZANO_RPC_URL || '',
    zanoRpcUser: overrides.zanoRpcUser || process.env.ZANO_RPC_USER || '',
    zanoRpcPassword: overrides.zanoRpcPassword || process.env.ZANO_RPC_PASSWORD || '',
    consolidation: {
      zano: {
        enabled: process.env.WATCHER_CONSOLIDATE_ZANO === 'true',
        address: process.env.WATCHER_CONSOLIDATE_ADDRESS_ZANO || '',
        feeAtomic: parseNumber(process.env.WATCHER_CONSOLIDATE_FEE_ZANO, 10000000000),
        minConfirmations: parseNumber(process.env.WATCHER_CONSOLIDATE_MIN_CONF_ZANO, 10)
      },
      fusd: {
        enabled: process.env.WATCHER_CONSOLIDATE_FUSD === 'true',
        address: process.env.WATCHER_CONSOLIDATE_ADDRESS_FUSD || '',
        feeAtomic: parseNumber(process.env.WATCHER_CONSOLIDATE_FEE_FUSD, 10000000000),
        minConfirmations: parseNumber(process.env.WATCHER_CONSOLIDATE_MIN_CONF_FUSD, 10)
      }
    }
  };

  config.enabled = config.tickers.length > 0;
  config.keyPrefix = process.env.WATCHER_KEY_PREFIX || 'zano';
  config.kvReady = Boolean(config.kvUrl && config.kvToken);
  return config;
};

const normalizeTicker = (ticker = '') => ticker.trim().toLowerCase();

module.exports = {
  loadWatcherConfig,
  normalizeTicker
};
