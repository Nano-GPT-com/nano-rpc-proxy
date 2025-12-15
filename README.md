# Nano RPC Proxy

[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js](https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Nano](https://img.shields.io/badge/Nano-4A90E2?style=for-the-badge&logo=nano&logoColor=white)](https://nano.org/)

A secure, production-ready proxy for Nano RPC nodes with API key authentication and granular action filtering.

## Features

- API key authentication for full access
- Whitelisted actions for public access without API key
- Rate limiting (different limits for public vs authenticated)
- CORS support
- Request logging
- Health check endpoint
- Optional internal-only `/zano` endpoint with method blocklist
- Graceful error handling

## Quick Start

### Development

```bash
# Build and run with docker-compose
docker-compose up --build

# Or run directly with Node.js
npm install
npm start
```

### Production Deployment

#### Option 1: Standard HTTP Deployment
```bash
# Build and run
docker build -t nano-rpc-proxy:latest .
docker-compose -f docker-compose.production.yml up -d
```

#### Option 2: HTTPS/SSL Deployment (Recommended)

1. **Initial SSL Setup:**
```bash
# SSH to your server
ssh user@your-server
cd ~/nano-rpc-proxy

# Run SSL setup (replace with your domain and email)
./setup-ssl.sh your-domain.com your-email@example.com
```

2. **Setup Auto-Renewal:**
```bash
# Setup automatic certificate renewal
./setup-cron.sh
```

**Prerequisites for SSL:**
- Your domain must point to your server IP
- Ports 80 and 443 must be open
- No other services using these ports

## Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
# Edit .env with your configuration
```

Environment variables:
- `PORT`: Port for the proxy server (default: 3000)
- `NANO_RPC_URL`: URL of your Nano RPC node (default: http://127.0.0.1:7076)
- `API_KEY`: API key for full access (generate with: `openssl rand -hex 32`)
- `ZANO_RPC_URL`: URL of your Zano wallet JSON-RPC (point to wallet RPC, default in compose: http://127.0.0.1:11212/json_rpc)
- `ZANO_API_KEY`: API key for `/zano` (no default; always required)
- `ZANO_ALLOWED_METHODS`: Comma-separated allowlist for `/zano` (defaults to `make_integrated_address,get_balance,get_payments`)
- `ZANO_WALLET_FILE`, `ZANO_WALLET_PASSWORD`, `ZANO_WALLET_RPC_PORT`: wallet RPC settings (simplewallet in RPC mode, default port 11212); point `ZANO_RPC_URL` to this wallet RPC for address generation/balance
- `PUBLIC_RATE_LIMIT_WINDOW_MS`, `PUBLIC_RATE_LIMIT_MAX`: Public rate limit for unauthenticated Nano RPC and other public routes (defaults 15min/100).
- `STATUS_RATE_LIMIT_WINDOW_MS`, `STATUS_RATE_LIMIT_MAX`: Separate public rate limit for `GET /api/transaction/status/...` polling (defaults 5min/600).
- `STATUS_CACHE_TTL_MS`: In-memory cache TTL for status lookups to reduce KV reads (default `min(5000, WATCHER_INTERVAL_MS)`).

> Keep secrets out of git: set `API_KEY` and `ZANO_API_KEY` in `.env` (gitignored) or your deployment environment. Compose files only reference these variables and do not embed key values.

## Zano RPC (internal use)

The `/zano` endpoint forwards JSON-RPC calls to your Zano daemon for internal services.

- Always requires an API key (`ZANO_API_KEY`).
- Uses an allowlist (default `make_integrated_address,get_balance,get_payments`); override with `ZANO_ALLOWED_METHODS`.
- For deposit flows, point `ZANO_RPC_URL` at the wallet JSON-RPC that supports address generation (e.g., integrated addresses) rather than the daemon-only port; create new deposit addresses from your backend and poll balances via the same `/zano` endpoint with the dedicated key.

Example request:

```bash
curl -X POST http://localhost:3000/zano \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ZANO_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"get_info","params":{}}'
```

Deposit flow examples (adjust `method`/`params` to your wallet RPC):

```bash
# 1) Create a new deposit address (e.g., integrated address with payment id)
curl -X POST http://localhost:3000/zano \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ZANO_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"make_integrated_address","params":{"payment_id":"<optional_payment_id>"}}'

# 2) Poll balance for that address (replace with the wallet RPC your setup uses)
curl -X POST http://localhost:3000/zano \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ZANO_API_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"get_balance","params":{"address":"<deposit_address>"}}'
```

## Zano/FUSD Deposit Watcher & Webhooks

The server watches Redis for pending deposit jobs and pushes a webhook once a transaction is confirmed. Optional: auto-consolidate confirmed deposits to a treasury address. All identifiers are `paymentId`-only.

**Env wiring**
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Upstash/Redis REST)
- `WATCHER_TICKERS` (e.g., `zano,fusd`)
- `WATCHER_WEBHOOK_URL` and `WATCHER_SHARED_SECRET` (header `X-Zano-Secret`)
- `WATCHER_INTERVAL_MS`, `WATCHER_SCAN_COUNT`, `WATCHER_JOB_TTL_SECONDS`, `WATCHER_SEEN_TTL_SECONDS`, `WATCHER_STATUS_TTL_SECONDS`
- `WATCHER_MIN_CONFIRMATIONS_ZANO` / `WATCHER_MIN_CONFIRMATIONS_FUSD` (defaults before dynamic tiers apply)
- `ZANO_RPC_URL` (wallet RPC for deposits)
- `ZANO_DECIMALS`, `FUSD_DECIMALS`
- Consolidation: `WATCHER_CONSOLIDATE_{ticker}=true`, `WATCHER_CONSOLIDATE_ADDRESS_{ticker}`, `WATCHER_CONSOLIDATE_FEE_{ticker}` (default fee 10_000_000_000 atomic)
- `WATCHER_KEY_PREFIX` (default `zano`)

**Keys in Redis**
- Jobs: `${PREFIX}:deposit:${ticker}:${paymentId}` → `address`, `paymentId`, `expectedAmount`, `minConf`, `clientReference`, `createdAt`, consolidation flags.
- Status: `${PREFIX}:transaction:status:${ticker}:${paymentId}` → status JSON.
- Seen: `${PREFIX}:seen:${txHash}` → dedupe once webhook succeeds.

**Endpoints**
- `POST /api/transaction/create` (API key required)  
  Body: `ticker`, `client_reference`.  
  Server generates a fresh integrated `address` and `paymentId` for the watcher job.  
  Returns: `paymentId`, `address`, initial `status`, `jobKey`.
- `GET /api/transaction/status/:ticker/:paymentId` — public polling.
- `POST /api/transaction/callback/:ticker` — webhook handler (requires `X-Zano-Secret`). Watcher sends:  
  - `paymentId`, `address`, `confirmations`, `hash`, `ticker`, `clientReference`, `createdAt`  
  - Amount fields: `paidAmount` / `paidAmountAtomic` (gross deposit), `effectiveAmount` / `effectiveAmountAtomic` (net after consolidation fee), `feeAtomic` when consolidation ran.  
  - Consolidation internals (tx id / errors) are not included in the webhook or status.

**Status values & fields**
- `PENDING`: job created, no deposit seen yet.
- `CONFIRMING`: deposit seen but not yet completed (shows `confirmations`, `hash`, and `requiredConfirmations`).
- `COMPLETED`: confirmations reached; webhook delivered.  
  Status includes `paidAmount`, `paidAmountAtomic`, `effectiveAmount`, `effectiveAmountAtomic`, `feeAtomic`, plus `paymentId`, `hash`, `confirmations`, `clientReference`, `address`. (No consolidation tx/error, no expectedAmount.)

**Dynamic confirmations**
- On first deposit detection (PENDING → CONFIRMING), the watcher recalculates the required confirmations from the on-chain amount:
  - `< 50` USD‑equivalent → `1` confirmation
  - `< 100` USD‑equivalent → `3` confirmations
  - `≥ 100` USD‑equivalent → `6` confirmations
- The computed value is stored on the job as `minConf` and used for subsequent checks.
  Status JSON exposes this as `requiredConfirmations`.

**Settlement note**: credit the user with `effectiveAmount` (net of the consolidation fee). `paidAmount` is the gross on-chain deposit.

**Flow**
1) Call `/api/transaction/create`; store `paymentId`, `address`, `client_reference`.
2) User pays that address (integrated address embeds `paymentId` for zano).
3) Watcher scans jobs:
   - If a deposit is seen below minConf → status `CONFIRMING`.
   - Once ≥ minConf → optional consolidation (one attempt per job) → webhook → mark seen → delete job.
   - If webhook fails, job is retained; consolidation is not retried.
4) Status endpoint always reflects latest stored state.

**Examples**
- Create:
  ```bash
  curl -s -X POST https://<host>/api/transaction/create \
    -H "Content-Type: application/json" \
    -H "x-api-key: $ZANO_API_KEY" \
    -d '{
      "ticker":"zano",
      "client_reference":"user-123"
    }'
  ```
- Status:
  ```bash
  curl -s https://<host>/api/transaction/status/zano/<paymentId>
  ```

**Watcher loop**
- Scans `deposit:{ticker}:*` every `WATCHER_INTERVAL_MS` (`scanCount` batch).
- Uses `ZANO_STATUS_URL` when set; otherwise wallet RPC `get_transfers`.
- On confirm ≥ minConf: optional consolidation, webhook, mark seen, delete job; else status `CONFIRMING`.
- Amounts formatted with configured decimals (default 12).

### Zano test script

Run a quick sanity check against the running proxy/Zano node:

```bash
ZANO_TEST_API_KEY=$ZANO_API_KEY npm run test:zano
# Optional overrides:
# ZANO_TEST_URL=http://your-host:3000/zano npm run test:zano
```

## Security Model

This proxy implements a **deny-by-default** security model:
- All RPC commands are **blocked** unless explicitly whitelisted
- API key authentication provides full access to all RPC commands
- Without API key, only safe read-only commands are allowed

## Allowed Actions (without API key)

The proxy allows **25+ verified standard Nano RPC commands** without authentication, including:

### Account Information
- `account_balance`, `account_info`, `account_history`
- `accounts_balances`, `account_key`

### Block Information  
- `block_count`, `block_info`, `blocks_info`
- `chain`, `successors`, `frontiers`, `frontier_count`

### Pending/Receivable Operations
- `receivable`, `accounts_receivable` (new format)
- `pending`, `accounts_pending` (legacy format)

### Network Information
- `version`, `peers`, `telemetry`
- `representatives`, `representatives_online`
- `available_supply`

### Utility Commands
- `nano_to_raw`, `raw_to_nano` (unit conversions)
- `validate_account_number`, `work_validate`

All state-modifying commands (like `send`, `receive`, `change`) and sensitive node operations require API key authentication.

## Testing

### Basic Tests

```bash
# Test without API key (allowed action)
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -d '{"action": "block_count"}'

# Test without API key (blocked action)
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -d '{"action": "send"}'

# Test with API key (full access)
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key-here" \
  -d '{"action": "send", ...}'

# Health check
curl http://localhost:3000/health
```

### Rate Limiting Test

Test that rate limiting is properly enforced:

```bash
# Test rate limiting (public access)
./test-rate-limit.sh https://your-domain.com

# Test with API key (should bypass rate limiting)
./test-rate-limit.sh https://your-domain.com your-api-key
```

The test script will:
- Send rapid requests for 30 seconds
- Show successful vs rate-limited requests  
- Verify the burst allowance (default: 20 requests)
- Optionally test that API keys bypass rate limiting

**Note**: Rate limited requests return HTTP 503 by default. To change this to HTTP 429 (Too Many Requests), run:
```bash
./fix-429-status-safe.sh your-domain.com
```

## Monitoring

View logs:
```bash
docker-compose logs -f nano-rpc-proxy
```

## Maintenance

### Available Scripts

```bash
# Deploy latest version (pulls code, builds, restarts)
./deploy.sh

# Check service status and health  
./status.sh

# Test rate limiting functionality
./test-rate-limit.sh https://your-domain.com

# Fix nginx to return 429 instead of 503 for rate limits
./fix-429-status-safe.sh your-domain.com

# Restore stable configuration if issues occur
./restore-working-config.sh your-domain.com
```

### Manual Commands
```bash
# Stop the service
docker-compose -f docker-compose.production.yml down

# Update and restart manually
git pull
docker build -t nano-rpc-proxy:latest .
docker-compose -f docker-compose.production.yml up -d

# View container status
docker ps

# View logs
docker logs -f nano-rpc-proxy

# Clean up old images
docker image prune -a
```
