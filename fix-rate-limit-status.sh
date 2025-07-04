#!/bin/bash

# Fix nginx to return 429 instead of 503 for rate limiting
# This script updates the nginx configuration to use proper HTTP status code

set -e

# Check if domain is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <domain>"
    echo "Example: $0 example.com"
    exit 1
fi

DOMAIN=$1

echo "🔧 Updating nginx to return 429 for rate limiting..."

# Create the updated SSL nginx config with 429 status
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

    # Custom error page for rate limiting (return 429 instead of 503)
    error_page 503 = @ratelimit;
    
    location @ratelimit {
        add_header Retry-After 60 always;
        add_header Content-Type "application/json" always;
        return 429 '{"error": "Too Many Requests", "message": "Rate limit exceeded. Please try again later."}';
    }

    # Proxy to Docker app
    location / {
        # Apply rate limiting (7 requests per minute with burst)
        limit_req zone=nano_rpc burst=20 nodelay;
        limit_req_status 503;  # nginx returns 503, we convert to 429 above
        
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
    echo "   - Header: Retry-After: 60"
    echo "   - JSON error response"
else
    echo "❌ Nginx configuration test failed"
    exit 1
fi