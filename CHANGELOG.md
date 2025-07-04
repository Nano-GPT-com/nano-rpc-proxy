# Changelog

## Repository Cleanup

### Removed Files (Obsolete/Redundant)
- `fix-rate-limit-status.sh` - Failed approach using error_page
- `fix-rate-limit-status-v2.sh` - Failed approach using limit_req_status (caused segfault)
- `fix-nginx-ssl.sh` - Obsolete SSL configuration script
- `fix-nginx-rate-limit.sh` - Obsolete rate limiting script  
- `nginx-config-updated.conf` - Leftover configuration file
- `test-rate-limiting.js` - Redundant Node.js test (shell version preferred)
- `test-rate-limit-detailed.sh` - Debug script not needed for end users
- `deploy-ssl.sh` - Complex SSL deployment (simplified)
- `deploy-ssl-existing-nginx.sh` - Specific deployment script
- `setup-ssl-existing-nginx.sh` - Specific setup script

### Current Scripts
- **Core**: `server.js`, `Dockerfile`, `docker-compose.*`
- **Deployment**: `deploy.sh`, `setup-ssl.sh`  
- **Testing**: `test-rate-limit.sh`, `test-proxy.sh`
- **Utilities**: `status.sh`, `setup-cron.sh`, `renew-ssl.sh`
- **Fixes**: `fix-429-status-safe.sh`, `restore-working-config.sh`

## Features
- ✅ Rate limiting with nginx (7 req/min + 20 burst)
- ✅ SSL/HTTPS support with Let's Encrypt
- ✅ 25+ whitelisted read-only Nano RPC commands
- ✅ API key authentication for full access
- ✅ JSON error responses for rate limits
- ✅ Automatic SSL certificate renewal