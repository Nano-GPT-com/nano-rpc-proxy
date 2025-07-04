#!/bin/bash

# SSL Certificate Renewal Script
# This script should be run via cron job

set -e

echo "🔄 Checking SSL certificate renewal..."

# Navigate to project directory
cd "$(dirname "$0")"

# Try to renew certificates
docker-compose -f docker-compose.ssl.yml run --rm certbot renew --quiet

# Check if renewal was successful and reload nginx
if [ $? -eq 0 ]; then
    echo "✅ Certificate renewal check completed"
    
    # Reload nginx to pick up new certificates
    docker-compose -f docker-compose.ssl.yml exec nginx-ssl nginx -s reload
    
    echo "🔄 Nginx reloaded with updated certificates"
else
    echo "❌ Certificate renewal failed"
    exit 1
fi