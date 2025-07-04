#!/bin/bash

# Fix nginx rate limiting syntax
# This script corrects the rate limiting configuration

set -e

DOMAIN=${1:-rpc.nano-gpt.com}

echo "🔧 Fixing nginx rate limiting syntax..."

# Remove the incorrect rate limiting zone from nginx.conf
echo "🗑️ Removing incorrect rate limiting from nginx.conf..."
sudo sed -i '/# Rate limiting for Nano RPC/d' /etc/nginx/nginx.conf
sudo sed -i '/limit_req_zone.*nano_rpc/d' /etc/nginx/nginx.conf

# Add the correct rate limiting zone to nginx.conf
echo "📝 Adding correct rate limiting zone to nginx.conf..."
if ! sudo grep -q "limit_req_zone.*nano_rpc" /etc/nginx/nginx.conf; then
    sudo sed -i '/http {/a\\t# Rate limiting for Nano RPC (100 requests per 15 minutes = ~6.67 per minute)\n\tlimit_req_zone $binary_remote_addr zone=nano_rpc:10m rate=7r/m;' /etc/nginx/nginx.conf
fi

# Create the corrected SSL nginx config with proper rate limiting
echo "📝 Creating corrected SSL nginx configuration..."
sudo tee /etc/nginx/sites-available/nano-rpc-ssl > /dev/null <<EOF
# HTTP redirect to HTTPS
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    # SSL configuration (managed by certbot)
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Client settings
    client_max_body_size 1M;
    client_body_buffer_size 1M;

    # Proxy to Docker app
    location / {
        # Apply rate limiting (7 requests per minute with burst)
        limit_req zone=nano_rpc burst=20 nodelay;
        
        proxy_pass http://127.0.0.1:3000;
        
        # Proxy headers
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Pass through headers
        proxy_set_header X-API-Key \$http_x_api_key;

        # Timeouts
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
        
        # Disable request buffering
        proxy_request_buffering off;
    }

    # Health check endpoint (bypass rate limiting)
    location /health {
        proxy_pass http://127.0.0.1:3000/health;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

# Test and reload nginx
echo "🔍 Testing nginx configuration..."
sudo nginx -t

if [ $? -eq 0 ]; then
    echo "✅ Nginx configuration is valid"
    echo "🔄 Reloading nginx..."
    sudo systemctl reload nginx
    
    echo "🎉 SSL configuration fixed!"
    echo "🔗 Your secure endpoint: https://$DOMAIN"
    echo ""
    echo "📊 Rate limiting: 7 requests/minute + 20 burst"
    echo "💡 This equals ~100 requests per 15 minutes"
    echo ""
    echo "📋 Testing endpoints:"
    echo "   Health: curl https://$DOMAIN/health"
    echo "   Version: curl -X POST https://$DOMAIN -H 'Content-Type: application/json' -d '{\"action\":\"version\"}'"
else
    echo "❌ Nginx configuration test failed"
    exit 1
fi