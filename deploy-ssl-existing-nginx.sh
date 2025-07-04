#!/bin/bash

# SSL Deployment Script for existing nginx setup
# This script deploys updates while maintaining SSL

set -e

echo "🚀 Deploying Nano RPC Proxy with existing nginx SSL..."

# Pull latest code
echo "📥 Pulling latest code..."
git pull

# Build the application
echo "🔨 Building application..."
docker build -t nano-rpc-proxy:latest .

# Deploy only the app container (nginx runs on host)
echo "🔄 Restarting proxy application..."
docker-compose -f docker-compose.ssl.yml up -d nano-rpc-proxy

# Show status
echo "📊 Checking service status..."
docker ps | grep nano-rpc-proxy-app || echo "❌ Container not found"

# Test health endpoint
echo "🔍 Testing health endpoint..."
curl -I http://localhost:3000/health 2>/dev/null | head -1 || echo "❌ Health endpoint not responding"

# Show logs
echo "📝 Recent logs:"
docker logs --tail=10 nano-rpc-proxy-app

echo "✅ Deployment complete!"
echo "🏥 Health check: curl http://localhost:3000/health"
echo "📝 Note: Configure your nginx/reverse proxy to expose this service"