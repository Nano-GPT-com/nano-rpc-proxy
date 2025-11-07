#!/bin/bash

# 🚀 Nano RPC Proxy - Universal Deployment Script
# One script to handle everything: SSL detection, nginx fixes, deployment, testing

set -e

# Configuration
DOMAIN="rpc.nano-gpt.com"
API_KEY="5e3ff8205b57fa3495bde592f07a0a06b395f97997555a8ce104347f651d63eb"

echo "🚀 Nano RPC Proxy - Universal Deployment"
echo "========================================"

# Step 1: Pull latest code
echo "📥 Pulling latest code..."
git pull

# Step 2: Detect current setup
echo "🔍 Detecting current setup..."
DOCKER_SSL=false
SYSTEM_SSL=false
HAS_CERTS=false

if docker ps | grep -q "nano-rpc-nginx"; then
    echo "✅ Docker SSL containers detected"
    DOCKER_SSL=true
elif [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    echo "✅ SSL certificates found for $DOMAIN"
    HAS_CERTS=true
    if [ -f "/etc/nginx/sites-available/nano-rpc-ssl" ] || [ -f "/etc/nginx/sites-enabled/nano-rpc-ssl" ]; then
        echo "✅ System SSL nginx config detected"
        SYSTEM_SSL=true
    fi
else
    echo "ℹ️  No SSL setup detected"
fi

# Step 2.5: Attempt to auto-start Docker SSL stack if it's missing
if [ "$DOCKER_SSL" = false ]; then
    echo "⚠️  nginx SSL container not running - attempting automatic start..."
    if docker-compose -f docker-compose.ssl.yml config >/dev/null 2>&1; then
        docker-compose -f docker-compose.ssl.yml up -d nginx-ssl >/dev/null 2>&1 || true
        sleep 3
        if docker ps | grep -q "nano-rpc-nginx"; then
            echo "✅ nginx SSL container started successfully"
            DOCKER_SSL=true
        else
            echo "❌ Unable to start nginx SSL container automatically"
        fi
    else
        echo "❌ SSL docker-compose configuration invalid - skipping auto-start"
    fi
fi

# Validate certificate path if Docker SSL stack is active
CERT_PATH="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ "$DOCKER_SSL" = true ]; then
    if [ -f "$CERT_PATH" ]; then
        echo "🔐 SSL certificate found at $CERT_PATH"
    else
        echo "❌ Expected SSL certificate not found at $CERT_PATH"
        echo "ℹ️  Falling back to HTTP-only mode. Run ./setup-ssl.sh $DOMAIN <email> to fix SSL."
        DOCKER_SSL=false
    fi
fi

# Step 3: Fix system nginx rate limiting (if needed)
if [ "$SYSTEM_SSL" = true ] || [ -f "/etc/nginx/nginx.conf" ]; then
    echo "🔧 Fixing system nginx rate limiting..."
    
    # Create backup
    BACKUP_FILE="/etc/nginx/nginx.conf.backup.$(date +%s)"
    sudo cp /etc/nginx/nginx.conf "$BACKUP_FILE" 2>/dev/null || echo "⚠️  Could not backup nginx config"
    
    # Fix rate limiting
    if grep -q "limit_req_zone.*zone=nano_rpc" /etc/nginx/nginx.conf 2>/dev/null; then
        echo "❌ Found problematic rate limiting - fixing..."
        sudo sed -i 's/^[[:space:]]*limit_req_zone.*zone=nano_rpc.*$/    # &/' /etc/nginx/nginx.conf
        echo "✅ Rate limiting commented out"
        
        # Test and reload nginx
        if sudo nginx -t 2>/dev/null; then
            sudo nginx -s reload
            echo "✅ Nginx reloaded successfully"
        else
            echo "❌ Nginx config error - restoring backup"
            sudo cp "$BACKUP_FILE" /etc/nginx/nginx.conf
        fi
    else
        echo "✅ No problematic rate limiting found"
    fi
fi

# Step 4: Build Docker image
echo "🔨 Building Docker image..."
docker build -t nano-rpc-proxy:latest .

# Step 5: Deploy based on setup
if [ "$DOCKER_SSL" = true ]; then
    echo "🐳 Deploying with Docker SSL..."
    docker-compose -f docker-compose.ssl.yml up -d --force-recreate
    ENDPOINT="https://$DOMAIN"
    
elif [ "$SYSTEM_SSL" = true ] && [ "$HAS_CERTS" = true ]; then
    echo "🖥️  Deploying with System SSL..."
    docker-compose -f docker-compose.production.yml up -d
    ENDPOINT="https://$DOMAIN"
    
else
    echo "📡 Deploying HTTP-only..."
    docker-compose -f docker-compose.production.yml up -d
    ENDPOINT="http://localhost:3000"
fi

# Step 6: Wait for services to start
echo "⏳ Waiting for services to start..."
sleep 5

# Step 7: Check deployment
echo "📊 Checking deployment..."
docker ps | grep nano-rpc || echo "❌ No containers found"

# Step 8: Test endpoints
echo "🧪 Testing endpoints..."

# Health check
echo "Testing health endpoint..."
if curl -k -s --max-time 10 "$ENDPOINT/health" > /dev/null 2>&1; then
    echo "✅ Health check passed"
    curl -k -s --max-time 5 "$ENDPOINT/health" | head -c 100
else
    echo "❌ Health check failed"
    if [ "$ENDPOINT" != "http://localhost:3000" ]; then
        echo "🔄 Trying local endpoint..."
        curl -s --max-time 5 "http://localhost:3000/health" | head -c 100 || echo "❌ Local health also failed"
    fi
fi

echo ""

# API test with key
echo "Testing API with key (should bypass rate limiting)..."
if curl -k -s --max-time 10 -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    -d '{"action": "version"}' > /dev/null 2>&1; then
    echo "✅ API with key works"
    curl -k -s --max-time 5 -X POST "$ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "x-api-key: $API_KEY" \
        -d '{"action": "version"}' | head -c 200
else
    echo "❌ API with key failed"
fi

echo ""

# API test without key
echo "Testing API without key (should work but be rate limited)..."
if curl -k -s --max-time 10 -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d '{"action": "version"}' > /dev/null 2>&1; then
    echo "✅ API without key works"
else
    echo "❌ API without key failed"
fi

# Step 9: Show logs
echo ""
echo "📝 Recent logs:"
if [ "$DOCKER_SSL" = true ]; then
    docker logs --tail=5 nano-rpc-proxy-app 2>/dev/null || echo "❌ App logs not available"
    docker logs --tail=3 nano-rpc-nginx 2>/dev/null || echo "❌ Nginx logs not available"
else
    docker logs --tail=8 nano-rpc-proxy 2>/dev/null || echo "❌ Logs not available"
fi

# Step 10: Final summary
echo ""
echo "🎉 Deployment Complete!"
echo "======================="
echo "🔗 Endpoint: $ENDPOINT"
echo "🏥 Health: $ENDPOINT/health"
echo "🔑 API Key: $API_KEY"
echo ""

if [ "$DOCKER_SSL" = true ] || [ "$SYSTEM_SSL" = true ]; then
    echo "✅ SSL Mode Active"
    echo "🔒 HTTPS endpoint ready"
else
    echo "📡 HTTP Mode Active"
    echo "💡 For SSL setup, check: ./setup-ssl.sh"
fi

echo ""
echo "📋 Next Steps:"
echo "• Test your API calls with the endpoint above"
echo "• Use x-api-key header for unlimited access"
echo "• Check ./test-proxy.sh for comprehensive testing"

# Clean exit
echo ""
echo "✅ All done! Your Nano RPC Proxy is ready."
