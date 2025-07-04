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
chmod +x setup-ssl.sh
./setup-ssl.sh your-domain.com your-email@example.com
```

2. **Setup Auto-Renewal:**
```bash
# Setup automatic certificate renewal
./setup-cron.sh
```

3. **Future Deployments:**
```bash
# Use the SSL deployment script
./deploy-ssl.sh
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

## Monitoring

View logs:
```bash
docker-compose logs -f nano-rpc-proxy
```

## Maintenance

### Quick Deployment (Recommended)
```bash
# Deploy latest version (pulls code, builds, restarts)
./deploy.sh

# Check service status and health
./status.sh
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