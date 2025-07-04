#!/bin/bash

# Safe fix for nginx to return 429 instead of 503 for rate limiting
# Uses error_page approach as fallback if limit_req_status fails

set -e

# Check if domain is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <domain>"
    echo "Example: $0 example.com"
    exit 1
fi

DOMAIN=$1

echo "🔧 Configuring nginx to return 429 for rate limiting (safe method)..."

# Check nginx version first
NGINX_VERSION=$(nginx -v 2>&1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
echo "📋 Nginx version: $NGINX_VERSION"

# Create the updated SSL nginx config with safer 429 approach
echo "📝 Creating nginx configuration with 429 status..."
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

    # Custom error page for rate limiting (converts any 503 to 429)
    error_page 503 @rate_limit_error;
    location @rate_limit_error {
        add_header Content-Type "application/json" always;
        add_header Retry-After "60" always;
        return 429 '{"error": "Too Many Requests", "message": "Rate limit exceeded. Please try again later.", "retry_after": 60}';
    }

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
        
        # Intercept backend 503 errors and convert to 429 if needed
        proxy_intercept_errors on;
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

# Test configuration before applying
echo "🔍 Testing nginx configuration..."
sudo nginx -t

if [ $? -eq 0 ]; then
    echo "✅ Configuration test passed"
    
    # Create backup of current config
    sudo cp /etc/nginx/sites-available/nano-rpc-ssl /etc/nginx/sites-available/nano-rpc-ssl.backup.$(date +%s)
    
    echo "🔄 Reloading nginx..."
    sudo systemctl reload nginx
    
    # Check if nginx is running
    if sudo systemctl is-active --quiet nginx; then
        echo "🎉 Configuration applied successfully!"
        echo "📊 Rate limiting will now return:"
        echo "   - Status: 429 Too Many Requests"
        echo "   - Header: Retry-After: 60"
        echo "   - JSON error response"
    else
        echo "❌ Nginx failed to start, restoring backup..."
        sudo systemctl stop nginx
        sudo cp /etc/nginx/sites-available/nano-rpc-ssl.backup.$(date +%s) /etc/nginx/sites-available/nano-rpc-ssl
        sudo systemctl start nginx
        exit 1
    fi
else
    echo "❌ Nginx configuration test failed"
    exit 1
fi