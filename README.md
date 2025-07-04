# Nano RPC Proxy

[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js](https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Nano](https://img.shields.io/badge/Nano-4A90E2?style=for-the-badge&logo=nano&logoColor=white)](https://nano.org/)

A secure, production-ready proxy for Nano RPC nodes with API key authentication and granular action filtering.

## Features

- API key authentication for full access
- Whitelisted actions for public access without API key
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

1. **Build the Docker image:**
```bash
docker build -t nano-rpc-proxy:latest .
```

2. **Deploy on your server:**
```bash
# Copy files to server
scp -r . nanogpt@130.185.119.52:~/nano-rpc-proxy/

# SSH to server
ssh nanogpt@130.185.119.52

# Navigate to directory
cd ~/nano-rpc-proxy

# Build and run
docker build -t nano-rpc-proxy:latest .
docker-compose -f docker-compose.production.yml up -d
```

3. **Update nginx configuration:**
```bash
# Backup current config
sudo cp /etc/nginx/sites-available/nano-rpc /etc/nginx/sites-available/nano-rpc.backup

# Update the config (copy content from nginx-config-updated.conf)
sudo nano /etc/nginx/sites-available/nano-rpc

# Test nginx config
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

## Configuration

Environment variables:
- `PORT`: Port for the proxy server (default: 3000)
- `NANO_RPC_URL`: URL of your Nano RPC node (default: http://127.0.0.1:7076)
- `API_KEY`: API key for full access

## Security Model

This proxy implements a **deny-by-default** security model:
- All RPC commands are **blocked** unless explicitly whitelisted
- API key authentication provides full access to all RPC commands
- Without API key, only safe read-only commands are allowed

## Allowed Actions (without API key)

The proxy allows **45+ safe read-only commands** without authentication, including:

### Account Information
- `account_balance`, `account_info`, `account_history`
- `account_block_count`, `account_representative`, `account_weight`
- `accounts_balances`, `accounts_frontiers`, `accounts_pending`

### Block Information
- `block_count`, `block_info`, `blocks_info`
- `block_hash`, `block_account`, `chain`
- `available_supply`, `successors`

### Network Information
- `version`, `peers`, `telemetry`, `uptime`
- `representatives`, `representatives_online`
- `confirmation_active`, `confirmation_history`
- `active_difficulty`, `frontier_count`

### Utility Commands
- `key_create`, `key_expand` (generate keypairs locally)
- `pending`, `receivable`, `unchecked` operations
- `nano_to_raw`, `raw_to_nano` (unit conversions)
- `validate_account_number`, `work_validate`

All state-modifying commands (like `send`, `receive`, `change`) and sensitive node operations require API key authentication.

## Testing

```bash
# Test without API key (allowed action)
curl -X POST http://130.185.119.52 \
  -H "Content-Type: application/json" \
  -d '{"action": "block_count"}'

# Test without API key (blocked action)
curl -X POST http://130.185.119.52 \
  -H "Content-Type: application/json" \
  -d '{"action": "send"}'

# Test with API key (full access)
curl -X POST http://130.185.119.52 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 5e3ff8205b57fa3495bde592f07a0a06b395f97997555a8ce104347f651d63eb" \
  -d '{"action": "send", ...}'

# Health check
curl http://130.185.119.52:3000/health
```

## Monitoring

View logs:
```bash
docker-compose logs -f nano-rpc-proxy
```

## Maintenance

```bash
# Stop the service
docker-compose down

# Update and restart
git pull
docker-compose up -d --build

# View container status
docker ps

# Clean up old images
docker image prune -a
```