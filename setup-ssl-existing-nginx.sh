#!/bin/bash

# SSL Setup Script for existing nginx
# This script sets up SSL certificates using Let's Encrypt with existing nginx

set -e

echo "🔒 Setting up SSL with existing nginx..."

# Check if domain and email are provided
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <domain> <email>"
    echo "Example: $0 example.com admin@example.com"
    exit 1
fi

DOMAIN=$1
EMAIL=$2

echo "📧 Using email: $EMAIL"
echo "🌐 Using domain: $DOMAIN"

# Install certbot if not already installed
if ! command -v certbot &> /dev/null; then
    echo "📦 Installing certbot..."
    sudo apt update
    sudo apt install -y certbot python3-certbot-nginx
fi

# Stop the Docker containers that might be using ports
echo "🛑 Stopping any conflicting Docker containers..."
docker-compose -f docker-compose.ssl.yml down 2>/dev/null || true

# Create temporary nginx config for certificate request
echo "📝 Creating temporary nginx config for SSL setup..."
sudo tee /etc/nginx/sites-available/nano-rpc-ssl > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

# Enable the site
sudo ln -sf /etc/nginx/sites-available/nano-rpc-ssl /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Start the proxy app (without Docker nginx)
echo "🚀 Starting Nano RPC proxy app..."
docker-compose -f docker-compose.ssl.yml up -d nano-rpc-proxy

echo "📜 Requesting SSL certificate..."
# Request certificate using nginx plugin
sudo certbot --nginx -d $DOMAIN --email $EMAIL --agree-tos --non-interactive

if [ $? -eq 0 ]; then
    echo "✅ SSL certificate obtained successfully!"
    
    # Create the final SSL nginx config
    echo "📝 Creating final SSL nginx configuration..."
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

    # Rate limiting
    limit_req_zone \$binary_remote_addr zone=nano_rpc:10m rate=100r/15m;
    limit_req zone=nano_rpc burst=20 nodelay;

    # Proxy to Docker app
    location / {
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
        limit_req off;
        proxy_pass http://127.0.0.1:3000/health;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

    # Test and reload nginx
    sudo nginx -t
    sudo systemctl reload nginx
    
    echo "🎉 SSL setup complete!"
    echo "🔗 Your secure endpoint: https://$DOMAIN"
    echo ""
    echo "📋 Next steps:"
    echo "1. Test the endpoint: curl https://$DOMAIN/health"
    echo "2. Certificate auto-renewal is already configured by certbot"
    echo ""
    echo "🔄 Certificate will auto-renew via systemd timer"
    echo "   Check status: sudo systemctl status certbot.timer"
    
else
    echo "❌ Failed to obtain SSL certificate"
    echo "🔍 Check that:"
    echo "1. Domain $DOMAIN points to this server's IP"
    echo "2. Port 80 is accessible from the internet"
    exit 1
fi