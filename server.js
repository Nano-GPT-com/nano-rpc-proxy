const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const NANO_RPC_URL = process.env.NANO_RPC_URL || 'http://127.0.0.1:7076';
const API_KEY = (process.env.API_KEY || '').trim();
const ZANO_RPC_URL = process.env.ZANO_RPC_URL || 'http://127.0.0.1:11211/json_rpc';
const ZANO_API_KEY = (process.env.ZANO_API_KEY || '').trim();
const ZANO_REQUIRE_API_KEY = true; // Always enforce API key for Zano
const ZANO_INTERNAL_ONLY = process.env.ZANO_INTERNAL_ONLY !== 'false';
const DEFAULT_ALLOWED_ZANO_METHODS = [
  'make_integrated_address',
  'get_balance',
  'get_payments'
];
const ZANO_ALLOWED_METHODS = (process.env.ZANO_ALLOWED_METHODS || '')
  .split(',')
  .map((method) => method.trim())
  .filter(Boolean);

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
const createRateLimit = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { error: message },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiting for public access only
const publicRateLimit = createRateLimit(
  15 * 60 * 1000, // 15 minutes
  100,            // 100 requests per 15 minutes for public access
  'Too many requests from this IP, please try again later'
);

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// Apply rate limiting only to public (non-API key) requests
app.use('/', (req, res, next) => {
  if (req.path.startsWith('/zano')) {
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
    if (ZANO_INTERNAL_ONLY && !isPrivateIp(clientIp)) {
      console.log(`Blocked Zano request from non-internal IP: ${clientIp}`);
      return res.status(403).json({
        error: 'Zano RPC is restricted to the internal network'
      });
    }

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
  console.log(`Zano internal only: ${ZANO_INTERNAL_ONLY}`);
  console.log('Use /health endpoint to check status');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
