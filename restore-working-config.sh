#!/bin/bash

# Restore working nginx configuration
# This reverts to the stable config that returns 503 for rate limits

set -e

# Check if domain is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <domain>"
    echo "Example: $0 example.com"
    exit 1
fi

DOMAIN=$1

echo "🔄 Restoring working nginx configuration..."

# Create the stable SSL nginx config (without problematic limit_req_status)
echo "📝 Creating stable SSL nginx configuration..."
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
    echo "🔄 Restarting nginx..."
    sudo systemctl restart nginx
    
    echo "🎉 Configuration restored!"
    echo "📊 Rate limiting returns 503 (stable version)"
    echo "🔗 Service should be accessible again"
else
    echo "❌ Nginx configuration test failed"
    exit 1
fi