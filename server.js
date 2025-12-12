const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { KvClient } = require('./kv');
const { loadWatcherConfig, normalizeTicker } = require('./watcher-config');
const {
  createDepositJob,
  readStatus,
  saveStatus,
  formatAtomicAmount
} = require('./deposits');
const { startDepositWatcher } = require('./watcher');

const app = express();

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const NANO_RPC_URL = process.env.NANO_RPC_URL || 'http://127.0.0.1:7076';
const API_KEY = (process.env.API_KEY || '').trim();
const ZANO_RPC_URL = process.env.ZANO_RPC_URL || 'http://127.0.0.1:11211/json_rpc';
const ZANO_API_KEY = (process.env.ZANO_API_KEY || '').trim();
const ZANO_REQUIRE_API_KEY = true; // Always enforce API key for Zano
const DEFAULT_ALLOWED_ZANO_METHODS = [
  'make_integrated_address',
  'get_balance',
  'get_payments'
];
const ZANO_ALLOWED_METHODS = (process.env.ZANO_ALLOWED_METHODS || '')
  .split(',')
  .map((method) => method.trim())
  .filter(Boolean);

const watcherConfig = loadWatcherConfig({ zanoRpcUrl: ZANO_RPC_URL });

let kvClient = null;
try {
  if (watcherConfig.kvUrl && watcherConfig.kvToken) {
    kvClient = new KvClient({
      url: watcherConfig.kvUrl,
      token: watcherConfig.kvToken
    });
  } else {
    console.warn('KV_REST_API_URL or KV_REST_API_TOKEN not set; deposit watcher and transaction routes are disabled.');
  }
} catch (error) {
  console.error('Failed to initialize KV client:', error.message);
}

const getTickerDecimals = (ticker) => watcherConfig.decimals[normalizeTicker(ticker)] || watcherConfig.decimals.zano || 12;
const getMinConfirmations = (ticker) => watcherConfig.minConfirmations[normalizeTicker(ticker)] || watcherConfig.minConfirmations.zano || 0;
const isTickerEnabled = (ticker) => watcherConfig.tickers.includes(normalizeTicker(ticker));

if (!API_KEY) {
  console.warn('API_KEY is not set; only whitelisted Nano actions will be accessible without authentication.');
}

if (ZANO_REQUIRE_API_KEY && !ZANO_API_KEY) {
  console.warn('ZANO_REQUIRE_API_KEY is true but ZANO_API_KEY is not set; /zano requests will be rejected until configured.');
}

if (ZANO_ALLOWED_METHODS.length === 0) {
  ZANO_ALLOWED_METHODS.push(...DEFAULT_ALLOWED_ZANO_METHODS);
}

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^fc00:/i,
  /^fd00:/i
];

const normalizeIp = (ip) => {
  if (!ip) return '';
  return ip.replace(/^::ffff:/, '');
};

const isPrivateIp = (ip) => {
  const normalized = normalizeIp(ip);
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(normalized));
};

const getClientIp = (req) => {
  const directIp = req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip;
  const normalizedDirectIp = normalizeIp(directIp);

  if (isPrivateIp(normalizedDirectIp)) {
    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) {
      return normalizeIp(forwarded);
    }
  }

  return normalizedDirectIp;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
};

const ensureKvClient = (res) => {
  if (!kvClient) {
    res.status(503).json({
      error: 'KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.'
    });
    return false;
  }
  return true;
};

// Allowed actions without API key - only confirmed standard Nano RPC commands
// These are verified safe read-only commands from the official Nano RPC protocol
const ALLOWED_ACTIONS = [
  // Core Nano node read-only commands (confirmed standard)
  'version',                  // Get node version
  'account_info',             // Get account information
  'account_history',          // Get account transaction history
  'account_balance',          // Get account balance
  'account_representative',   // Get account representative
  'account_weight',           // Get account weight
  'accounts_balances',        // Get balances for multiple accounts
  'accounts_frontiers',       // Get frontiers for multiple accounts
  'block_info',               // Get block information
  'block_account',            // Get account from block hash
  'blocks_info',              // Get information for multiple blocks
  'block_count',              // Get block count
  'account_key',              // Get public key from account
  
  // Pending/receivable commands (standard)
  'receivable',               // Get receivable blocks (new name for pending)
  'receivable_exists',        // Check if receivable block exists
  'accounts_receivable',      // Get receivable blocks for multiple accounts
  'pending',                  // Get pending blocks (legacy name)
  'pending_exists',           // Check if pending block exists (legacy)
  'accounts_pending',         // Get pending blocks for multiple accounts (legacy)
  
  // Utility/conversion commands (confirmed standard)
  'nano_to_raw',              // Unit conversion
  'raw_to_nano',              // Unit conversion
  'key_create',               // Generate random key pair
  
  // Network information (standard)
  'representatives',          // Get representatives list
  'representatives_online',   // Get online representatives
  'confirmation_quorum',      // Get confirmation quorum info
  'delegators',               // Get delegators for representative
  'telemetry',                // Get telemetry data
  'peers',                    // Get peer information
  'available_supply',         // Get available supply
  
  // Block operations (read-only)
  'chain',                    // Get chain of blocks
  'successors',               // Get successor blocks
  'frontiers',                // Get account frontiers
  'frontier_count',           // Get frontier count
  
  // Validation (safe)
  'validate_account_number',  // Validate account format
  'work_validate',            // Validate work (doesn't generate)
  
  // Block processing (write operation - use with caution)
  'process',                  // Process/submit blocks to network
  
  // Deprecated but still functional
  'active_difficulty'         // Get active difficulty (deprecated)
  
  // Note: Removed non-standard/custom commands that may not exist on all nodes:
  // - 'find_block', 'price', 'reps', 'rep_info', 'known', 'get_name', 
  // - 'market_data', 'rpc_credits' (these appear to be custom/service-specific)
];

// Rate limiting configuration
const createRateLimit = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req)
  });

const PUBLIC_RATE_LIMIT_WINDOW_MS = parsePositiveInt(
  process.env.PUBLIC_RATE_LIMIT_WINDOW_MS,
  15 * 60 * 1000
);
const PUBLIC_RATE_LIMIT_MAX = parsePositiveInt(process.env.PUBLIC_RATE_LIMIT_MAX, 100);
const STATUS_RATE_LIMIT_WINDOW_MS = parsePositiveInt(
  process.env.STATUS_RATE_LIMIT_WINDOW_MS,
  5 * 60 * 1000
);
const STATUS_RATE_LIMIT_MAX = parsePositiveInt(process.env.STATUS_RATE_LIMIT_MAX, 600);
const STATUS_CACHE_TTL_MS = parsePositiveInt(
  process.env.STATUS_CACHE_TTL_MS,
  Math.min(5000, watcherConfig.intervalMs)
);

const statusCache = new Map();

// Rate limiting for public access only
const publicRateLimit = createRateLimit(
  PUBLIC_RATE_LIMIT_WINDOW_MS,
  PUBLIC_RATE_LIMIT_MAX,
  'Too many requests from this IP, please try again later'
);

const statusRateLimit = createRateLimit(
  STATUS_RATE_LIMIT_WINDOW_MS,
  STATUS_RATE_LIMIT_MAX,
  'Too many requests from this IP, please try again later'
);

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// Apply rate limiting only to public (non-API key) requests
app.use('/', (req, res, next) => {
  if (req.path.startsWith('/zano') || req.path.startsWith('/api/transaction/status')) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey === API_KEY) {
    // No rate limit for authenticated requests
    next();
  } else {
    // Rate limit for public requests
    publicRateLimit(req, res, next);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// Main RPC proxy endpoint
app.post('/', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    
    // Check if API key is provided and valid
    if (apiKey === API_KEY) {
      console.log('Request authorized with API key');
      const response = await axios.post(NANO_RPC_URL, req.body, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      return res.json(response.data);
    }
    
    // No API key - check if action is allowed
    const { action } = req.body;
    
    if (!action) {
      return res.status(400).json({ 
        error: 'Missing action in request body' 
      });
    }
    
    if (!ALLOWED_ACTIONS.includes(action)) {
      console.log(`Blocked unauthorized action: ${action}`);
      return res.status(403).json({ 
        error: 'RPC command not permitted. Use X-API-Key header for full access.',
        allowed_actions: ALLOWED_ACTIONS
      });
    }
    
    // Forward allowed request
    console.log(`Forwarding allowed action: ${action}`);
    const response = await axios.post(NANO_RPC_URL, req.body, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    
    res.json(response.data);
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    
    if (error.response) {
      // Forward error from Nano RPC
      res.status(error.response.status).json(error.response.data);
    } else if (error.code === 'ECONNREFUSED') {
      res.status(503).json({ 
        error: 'Nano RPC node is not accessible' 
      });
    } else if (error.code === 'ETIMEDOUT') {
      res.status(504).json({ 
        error: 'Request to Nano RPC timed out' 
      });
    } else {
      res.status(500).json({ 
        error: 'Internal proxy error' 
      });
    }
  }
});

// Zano RPC proxy endpoint - restricted to internal use with method blocking
app.post('/zano', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    if (ZANO_REQUIRE_API_KEY) {
      if (!ZANO_API_KEY) {
        return res.status(500).json({
          error: 'Zano API key is not configured'
        });
      }

      const apiKey = req.headers['x-api-key'];
      if (apiKey !== ZANO_API_KEY) {
        return res.status(401).json({
          error: 'Invalid or missing API key for Zano RPC'
        });
      }
    }

    const { method } = req.body || {};
    if (!method) {
      return res.status(400).json({
        error: 'Missing method in request body'
      });
    }

    if (!ZANO_ALLOWED_METHODS.includes(method)) {
      console.log(`Blocked Zano method (not allowlisted): ${method}`);
      return res.status(403).json({
        error: 'Zano RPC method not permitted',
        allowed_methods: ZANO_ALLOWED_METHODS
      });
    }

    const response = await axios.post(ZANO_RPC_URL, req.body, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    res.json(response.data);
  } catch (error) {
    console.error('Zano proxy error:', error.message);

    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else if (error.code === 'ECONNREFUSED') {
      res.status(503).json({
        error: 'Zano RPC node is not accessible'
      });
    } else if (error.code === 'ETIMEDOUT') {
      res.status(504).json({
        error: 'Request to Zano RPC timed out'
      });
    } else {
      res.status(500).json({
        error: 'Internal Zano proxy error'
      });
    }
  }
});

// Transaction status (public) and webhook/capture endpoints (protected)
app.get('/api/transaction/status/:ticker/:paymentId', statusRateLimit, async (req, res) => {
  try {
    if (!ensureKvClient(res)) return;

    const ticker = normalizeTicker(req.params.ticker);
    const { paymentId } = req.params;

    if (!ticker || !paymentId) {
      return res.status(400).json({ error: 'ticker and paymentId are required' });
    }

    if (watcherConfig.logLevel === 'debug') {
      console.log('Status lookup request', {
        ticker,
        paymentId,
        keyPrefix: watcherConfig.keyPrefix,
        kvUrl: process.env.KV_REST_API_URL,
        kvTokenSet: Boolean(process.env.KV_REST_API_TOKEN)
      });
    }

    const statusKey = `${watcherConfig.keyPrefix}:transaction:status:${ticker}:${paymentId}`;

    const cached = statusCache.get(statusKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (watcherConfig.logLevel === 'debug') {
        console.log('Status lookup cache hit', { ticker, paymentId });
      }
      return res.json(cached.value);
    }
    if (cached) {
      statusCache.delete(statusKey);
    }
    let rawStatus = null;
    try {
      rawStatus = await kvClient.get(statusKey);
    } catch (e) {
      if (watcherConfig.logLevel !== 'error') {
        console.error('Status raw get error', { key: statusKey, error: e.message });
      }
    }

    const status = await readStatus(kvClient, ticker, paymentId, watcherConfig.keyPrefix);
    if (!status) {
      if (watcherConfig.logLevel !== 'error') {
        console.log('Status lookup miss', {
          ticker,
          paymentId,
          keyPrefix: watcherConfig.keyPrefix,
          statusKey,
          rawStatus
        });
      }
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (STATUS_CACHE_TTL_MS > 0) {
      statusCache.set(statusKey, {
        value: status,
        expiresAt: Date.now() + STATUS_CACHE_TTL_MS
      });
    }

    if (watcherConfig.logLevel !== 'error') {
      console.log('Status lookup hit', {
        ticker,
        paymentId,
        keyPrefix: watcherConfig.keyPrefix,
        status: status.status,
        updatedAt: status.updatedAt
      });
    }
    res.json(status);
  } catch (error) {
    console.error('Status lookup error:', error.message);
    res.status(500).json({ error: 'Failed to read transaction status' });
  }
});

app.post('/api/transaction/create', async (req, res) => {
  try {
    if (!ensureKvClient(res)) return;

    const apiKey = (req.headers['x-api-key'] || '').trim();
    if (!ZANO_API_KEY || apiKey !== ZANO_API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing Zano API key' });
    }

    const {
      ticker,
      address,
      payment_id: paymentIdInput,
      expectedAmount,
      // minConf is intentionally ignored; min confirmations are server-configured
      client_reference: clientReferenceInput,
      ttlSeconds
    } = req.body || {};

    const normalizedTicker = normalizeTicker(ticker);
    if (!normalizedTicker) {
      return res.status(400).json({ error: 'ticker is required' });
    }

    if (!isTickerEnabled(normalizedTicker)) {
      return res.status(400).json({ error: `Ticker ${normalizedTicker} is not enabled for the watcher` });
    }

    let finalAddress = address && address.trim();
    let generatedPaymentId = null;

    // Convenience: if no address provided for Zano, auto-generate an integrated address
    if (!finalAddress && normalizedTicker === 'zano') {
      try {
        const payload = {
          jsonrpc: '2.0',
          id: `make-int-${Date.now()}`,
          method: 'make_integrated_address',
          params: {}
        };
        if (paymentIdInput) {
          payload.params.payment_id = paymentIdInput;
        }
        const headers = { 'Content-Type': 'application/json' };
        if (ZANO_API_KEY) headers['X-API-Key'] = ZANO_API_KEY;

        const rpcResp = await axios.post(ZANO_RPC_URL, payload, {
          headers,
          timeout: 10000,
          validateStatus: () => true
        });

        if (rpcResp.status >= 400 || rpcResp.data?.error) {
          return res.status(502).json({
            error: 'Failed to generate integrated address',
            details: rpcResp.data?.error?.message || rpcResp.status
          });
        }

        finalAddress = rpcResp.data?.result?.integrated_address || '';
        generatedPaymentId = rpcResp.data?.result?.payment_id || null;
      } catch (err) {
        console.error('make_integrated_address failed:', err.message);
        return res.status(502).json({ error: 'Failed to generate integrated address' });
      }
    }

    const finalPaymentId = generatedPaymentId || paymentIdInput || '';
    const finalTxId = finalPaymentId; // use paymentId as canonical id
    const clientReference = clientReferenceInput || '';

    if (!clientReference) {
      return res.status(400).json({ error: 'client_reference is required' });
    }

    if (!finalAddress) {
      return res.status(400).json({ error: 'address is required (or allow auto-generation for zano)' });
    }

    if (!finalPaymentId) {
      return res.status(400).json({ error: 'payment_id is required (or allow us to generate one)' });
    }

    const createdAt = new Date().toISOString();
    const jobTtl = parsePositiveInt(ttlSeconds, watcherConfig.jobTtlSeconds);
    const minConfirmations = getMinConfirmations(normalizedTicker);

    const job = await createDepositJob(
      kvClient,
      {
        ticker: normalizedTicker,
        address: finalAddress,
        txId: finalTxId,
        expectedAmount: expectedAmount ?? '',
        minConf: minConfirmations,
        clientReference,
        paymentId: finalPaymentId,
        createdAt
      },
      {
        ttlSeconds: jobTtl,
        defaultMinConf: minConfirmations,
        keyPrefix: watcherConfig.keyPrefix
      }
    );

  console.log('Deposit job created', {
    key: job.key,
    ticker: normalizedTicker,
    txId: finalTxId,
    paymentId: finalPaymentId,
      keyPrefix: watcherConfig.keyPrefix
    });

    const status = await saveStatus(
      kvClient,
      normalizedTicker,
      finalTxId,
      {
        status: 'PENDING',
        address: finalAddress,
        confirmations: 0,
        clientReference,
        paymentId: finalPaymentId,
        createdAt
      },
      { ttlSeconds: watcherConfig.statusTtlSeconds, keyPrefix: watcherConfig.keyPrefix }
    );

    console.log('Status record saved', {
      ticker: normalizedTicker,
      txId: finalTxId,
      paymentId: finalPaymentId,
      keyPrefix: watcherConfig.keyPrefix
    });

    res.json({
      ok: true,
      jobKey: job.key,
      ttlSeconds: jobTtl,
      status,
      address: finalAddress,
      paymentId: finalPaymentId,
      expiresAt: new Date(Date.now() + jobTtl * 1000).toISOString()
    });
  } catch (error) {
    console.error('Create transaction job error:', error);
    res.status(500).json({ error: 'Failed to create deposit job' });
  }
});

app.post('/api/transaction/callback/:ticker', async (req, res) => {
  try {
    if (!ensureKvClient(res)) return;

    if (!watcherConfig.webhookSecret) {
      return res.status(503).json({ error: 'WATCHER_SHARED_SECRET is not configured' });
    }

    const providedSecret = (req.headers['x-zano-secret'] || '').trim();
    if (providedSecret !== watcherConfig.webhookSecret) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const ticker = normalizeTicker(req.params.ticker || req.body?.ticker);
    const { paymentId, address, amount, amountAtomic, expectedAmount, confirmations, hash, sessionUUID, createdAt } =
      req.body || {};

    if (!ticker) {
      return res.status(400).json({ error: 'Ticker is required in path or body' });
    }

    if (!isTickerEnabled(ticker)) {
      return res.status(400).json({ error: `Ticker ${ticker} is not enabled for the watcher` });
    }

    if (!paymentId || !address || !hash) {
      return res.status(400).json({ error: 'paymentId, address, and hash are required' });
    }

    const decimals = getTickerDecimals(ticker);
    const paidAmount = amount || formatAtomicAmount(amountAtomic, decimals) || '';
    const payload = await saveStatus(
      kvClient,
      ticker,
      paymentId,
      {
        status: 'COMPLETED',
        address,
        expectedAmount: expectedAmount ?? '',
        confirmations: parsePositiveInt(confirmations, 0),
        hash,
        paidAmount,
        paidAmountAtomic: amountAtomic ?? '',
        sessionUUID: sessionUUID || '',
        createdAt: createdAt || new Date().toISOString()
      },
      { ttlSeconds: watcherConfig.statusTtlSeconds, keyPrefix: watcherConfig.keyPrefix }
    );

    res.json({ ok: true, status: payload });
  } catch (error) {
    console.error('Webhook callback error:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Nano RPC Proxy listening on port ${PORT}`);
  console.log(`Proxying to: ${NANO_RPC_URL}`);
  console.log(`Total allowed actions without API key: ${ALLOWED_ACTIONS.length}`);
  console.log(`Zano RPC proxy available at /zano -> ${ZANO_RPC_URL}`);
  console.log(`Zano allowed methods: ${ZANO_ALLOWED_METHODS.length}`);
  console.log('Use /health endpoint to check status');
  startDepositWatcher(kvClient, watcherConfig);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
