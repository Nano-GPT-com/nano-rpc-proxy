const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const NANO_RPC_URL = process.env.NANO_RPC_URL || 'http://127.0.0.1:7076';
const API_KEY = process.env.API_KEY || '5e3ff8205b57fa3495bde592f07a0a06b395f97997555a8ce104347f651d63eb';

// Allowed actions without API key - only confirmed standard Nano RPC commands
// These are verified safe read-only commands from the official Nano RPC protocol
const ALLOWED_ACTIONS = [
  // Core Nano node read-only commands (confirmed standard)
  'version',                  // Get node version
  'account_info',             // Get account information
  'account_history',          // Get account transaction history
  'account_balance',          // Get account balance
  'accounts_balances',        // Get balances for multiple accounts
  'block_info',               // Get block information
  'blocks_info',              // Get information for multiple blocks
  'block_count',              // Get block count
  'account_key',              // Get public key from account
  
  // Pending/receivable commands (standard)
  'receivable',               // Get receivable blocks (new name for pending)
  'accounts_receivable',      // Get receivable blocks for multiple accounts
  'pending',                  // Get pending blocks (legacy name)
  'accounts_pending',         // Get pending blocks for multiple accounts (legacy)
  
  // Utility/conversion commands (confirmed standard)
  'nano_to_raw',              // Unit conversion
  'raw_to_nano',              // Unit conversion
  
  // Network information (standard)
  'representatives',          // Get representatives list
  'representatives_online',   // Get online representatives
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
  'work_validate'             // Validate work (doesn't generate)
  
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
  console.log('Use /health endpoint to check status');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});