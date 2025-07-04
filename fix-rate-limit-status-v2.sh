#!/bin/bash

# Fix nginx to return 429 instead of 503 for rate limiting (version 2)
# This uses limit_req_status directive which is the proper way

set -e

# Check if domain is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <domain>"
    echo "Example: $0 example.com"
    exit 1
fi

DOMAIN=$1

echo "🔧 Updating nginx to return 429 for rate limiting (v2)..."

# Create the updated SSL nginx config with limit_req_status
echo "📝 Creating updated SSL nginx configuration..."
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

    # Set rate limit status to 429 (proper way)
    limit_req_status 429;

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
    
    echo "🎉 Configuration updated!"
    echo "📊 Rate limiting will now return:"
    echo "   - Status: 429 Too Many Requests"
    echo "   - Uses limit_req_status directive (proper method)"
else
    echo "❌ Nginx configuration test failed"
    exit 1
fi