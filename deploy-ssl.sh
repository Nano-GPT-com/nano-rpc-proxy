#!/bin/bash

# SSL Deployment Script for Nano RPC Proxy
# This script sets up the complete SSL infrastructure

set -e

echo "🚀 Deploying Nano RPC Proxy with SSL..."

# Pull latest code
echo "📥 Pulling latest code..."
git pull

# Build the application
echo "🔨 Building application..."
docker build -t nano-rpc-proxy:latest .

# Deploy with SSL
echo "🔒 Starting SSL-enabled services..."
docker-compose -f docker-compose.ssl.yml up -d nano-rpc-proxy nginx-ssl

# Show status
echo "📊 Checking service status..."
docker ps | grep nano-rpc || echo "❌ Containers not found"

# Show logs
echo "📝 Recent logs:"
docker-compose -f docker-compose.ssl.yml logs --tail=10

echo "✅ SSL deployment complete!"
echo "🏥 Health check: curl http://localhost:3000/health"
echo "📝 Note: Ensure your domain points to this server and ports 80/443 are open"