# Nano RPC Proxy Security Configuration

## Security Model

This proxy implements a **deny-by-default** security model where all RPC commands are blocked unless explicitly whitelisted.

## Blocked Commands (Require API Key)

The following commands are **BLOCKED** without proper API key authentication as they can:
- Modify blockchain state
- Access wallet funds
- Control node operations
- Expose sensitive information

### Wallet Operations (HIGH RISK)
- `wallet_*` - All wallet commands
- `send` - Send Nano from accounts
- `receive` - Receive pending blocks
- `change` - Change account representative
- `account_create` - Create new accounts

### Key Generation (HIGH RISK)
- `key_create` - Could derive keys from node seed
- `key_expand` - Could expose key derivation patterns

### Node Control (HIGH RISK)
- `stop` - Stop the node
- `bootstrap` - Control bootstrap operations
- `bootstrap_any` - Bootstrap from any source
- `bootstrap_lazy` - Lazy bootstrap mode
- `keepalive` - Send keepalive packets
- `epoch_upgrade` - Upgrade epoch blocks

### Work Generation
- `work_cancel` - Cancel work generation
- `work_generate` - Generate proof of work
- `work_get` - Get work from pool
- `work_set` - Set work for account

### Sensitive Information
- `node_id` - Node identity information
- `node_id_delete` - Delete node identity
- `stats` - Detailed node statistics
- `stats_clear` - Clear statistics
- `ledger` - Direct ledger access
- `database_txn_tracker` - Database transaction tracking

### State Modification
- `block_confirm` - Force block confirmation
- `block_create` - Create new blocks
- `confirmation_height_currently_processing` - Processing information
- `republish` - Republish blocks
- `sign` - Sign blocks

### Debug/Development
- `debug_*` - All debug commands
- `election_statistics` - Detailed election data
- `confirmation_height_currently_processing` - Internal processing state

## Whitelisted Commands

Only commands that are:
1. Read-only (don't modify state)
2. Safe (don't expose sensitive node information)
3. Useful for public access

Are included in the whitelist. See `server.js` for the complete list.

## API Key Usage

With a valid API key in the `X-API-Key` header, ALL commands are allowed, giving full control over the node. Protect your API key!

## Rate Limiting

Consider implementing rate limiting for both authenticated and unauthenticated requests to prevent abuse. This can be added using packages like `express-rate-limit`.