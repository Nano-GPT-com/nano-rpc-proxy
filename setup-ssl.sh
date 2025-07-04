#!/bin/bash

# SSL Setup Script for Nano RPC Proxy
# This script sets up SSL certificates using Let's Encrypt

set -e

echo "🔒 Setting up SSL for Nano RPC Proxy..."

# Check if domain is provided
DOMAIN=${1:-rpc.nano-gpt.com}
EMAIL=${2:-admin@nano-gpt.com}

echo "📧 Using email: $EMAIL"
echo "🌐 Using domain: $DOMAIN"

# Create necessary directories
sudo mkdir -p /etc/letsencrypt
sudo mkdir -p /var/www/certbot

# Update the certbot command with provided email
sed -i "s/your-email@example.com/$EMAIL/g" docker-compose.ssl.yml
sed -i "s/rpc.nano-gpt.com/$DOMAIN/g" docker-compose.ssl.yml
sed -i "s/rpc.nano-gpt.com/$DOMAIN/g" nginx/ssl.conf

echo "🚀 Starting services for initial certificate request..."

# Start nginx without SSL first
docker-compose -f docker-compose.ssl.yml up -d nginx-ssl

echo "⏳ Waiting for nginx to start..."
sleep 5

echo "📜 Requesting SSL certificate..."
# Request certificate
docker-compose -f docker-compose.ssl.yml run --rm certbot

if [ $? -eq 0 ]; then
    echo "✅ SSL certificate obtained successfully!"
    
    echo "🔄 Restarting services with SSL..."
    # Restart nginx with SSL
    docker-compose -f docker-compose.ssl.yml restart nginx-ssl
    
    echo "🎉 SSL setup complete!"
    echo "🔗 Your secure endpoint: https://$DOMAIN"
    echo ""
    echo "📋 Next steps:"
    echo "1. Test the endpoint: curl https://$DOMAIN/health"
    echo "2. Set up certificate renewal cron job"
    echo "3. Update your DNS A record to point $DOMAIN to this server"
    echo ""
    echo "🔄 To renew certificates, run:"
    echo "   docker-compose -f docker-compose.ssl.yml run --rm certbot renew"
    
else
    echo "❌ Failed to obtain SSL certificate"
    echo "🔍 Check that:"
    echo "1. Domain $DOMAIN points to this server's IP"
    echo "2. Port 80 is accessible from the internet"
    echo "3. No other service is using port 80"
    exit 1
fi