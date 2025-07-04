#!/bin/bash

# Nano RPC Proxy Deployment Script
# This script pulls the latest code, builds the Docker image, and restarts the service

set -e  # Exit on any error

echo "🚀 Starting Nano RPC Proxy deployment..."

# Pull latest code from git
echo "📥 Pulling latest code..."
git pull

# Build new Docker image
echo "🔨 Building Docker image..."
docker build -t nano-rpc-proxy:latest .

# Restart the service with the new image
echo "♻️  Restarting service..."
docker-compose -f docker-compose.production.yml up -d

# Show status
echo "📊 Checking service status..."
docker ps | grep nano-rpc-proxy || echo "❌ Container not found"

# Show recent logs
echo "📝 Recent logs:"
docker logs --tail=10 nano-rpc-proxy

echo "✅ Deployment complete!"
echo "🔗 Service should be running on port 3000"
echo "🏥 Health check: curl http://localhost:3000/health"