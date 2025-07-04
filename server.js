const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');

const app = express();

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const NANO_RPC_URL = process.env.NANO_RPC_URL || 'http://127.0.0.1:7076';
const API_KEY = process.env.API_KEY || '5e3ff8205b57fa3495bde592f07a0a06b395f97997555a8ce104347f651d63eb';

// Allowed actions without API key - comprehensive whitelist based on Nano RPC documentation
// These are read-only commands that don't modify state or expose sensitive node information
const ALLOWED_ACTIONS = [
  // Account information (read-only)
  'account_balance',          // Get account balance
  'account_block_count',      // Get number of blocks for an account
  'account_get',              // Get account number from public key
  'account_history',          // Get account transaction history
  'account_info',             // Get account information
  'account_key',              // Get public key from account
  'account_representative',   // Get account's representative
  'account_weight',           // Get voting weight of account
  'accounts_balances',        // Get balances for multiple accounts
  'accounts_frontiers',       // Get frontiers for multiple accounts
  'accounts_pending',         // Get pending blocks for accounts
  'accounts_representatives', // Get representatives for multiple accounts
  
  // Block information (read-only)
  'available_supply',         // Get available supply
  'block_account',            // Get account that owns a block
  'block_count',              // Get block count
  'block_count_type',         // Get block count by type
  'block_hash',               // Convert block to hash
  'block_info',               // Get block information
  'blocks',                   // Get blocks by hash
  'blocks_info',              // Get information for multiple blocks
  'chain',                    // Get chain of blocks
  'successors',               // Get successor blocks
  
  // Network information (read-only)
  'active_difficulty',        // Get active network difficulty
  'confirmation_active',      // Get active elections
  'confirmation_history',     // Get confirmation history
  'confirmation_quorum',      // Get confirmation quorum
  'delegators',               // Get delegators for representative
  'delegators_count',         // Get delegator count
  'frontier_count',           // Get frontier count
  'frontiers',                // Get account frontiers
  'peers',                    // Get peer information
  'representatives',          // Get representatives list
  'representatives_online',   // Get online representatives
  'telemetry',                // Get telemetry data
  'version',                  // Get node version
  
  // Utility commands (safe)
  'key_create',               // Generate random keypair (doesn't affect node)
  'key_expand',               // Derive public key and account
  'pending',                  // Get pending blocks
  'pending_exists',           // Check if pending block exists
  'process',                  // Process a block (read-only check)
  'receivable',               // Get receivable blocks
  'receivable_exists',        // Check if receivable exists
  'unchecked',                // Get unchecked blocks
  'unchecked_get',            // Get specific unchecked block
  'unchecked_keys',           // Get unchecked block hashes
  'unopened',                 // Get unopened accounts
  'uptime',                   // Get node uptime
  'work_validate',            // Validate work (doesn't generate)
  
  // Price/conversion (safe)
  'nano_to_raw',              // Unit conversion
  'raw_to_nano',              // Unit conversion
  
  // Validation (safe)
  'validate_account_number'   // Validate account format
];

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

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