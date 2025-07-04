#!/bin/bash

# Nano RPC Proxy Status Script
# Check the health and status of the proxy service

echo "📊 Nano RPC Proxy Status Check"
echo "================================"

# Check if container is running
echo "🐳 Docker Container Status:"
if docker ps | grep -q nano-rpc-proxy; then
    echo "✅ Container is running"
    docker ps | grep nano-rpc-proxy
else
    echo "❌ Container is not running"
    echo "Last container status:"
    docker ps -a | grep nano-rpc-proxy || echo "No container found"
fi

echo ""

# Check health endpoint
echo "🏥 Health Check:"
if curl -s http://localhost:3000/health > /dev/null; then
    echo "✅ Health endpoint responding"
    curl -s http://localhost:3000/health | jq . 2>/dev/null || curl -s http://localhost:3000/health
else
    echo "❌ Health endpoint not responding"
fi

echo ""

# Test a simple RPC call
echo "🔧 RPC Test (version command):"
if curl -s -X POST http://localhost:3000 \
    -H "Content-Type: application/json" \
    -d '{"action": "version"}' > /dev/null; then
    echo "✅ RPC endpoint responding"
    curl -s -X POST http://localhost:3000 \
        -H "Content-Type: application/json" \
        -d '{"action": "version"}' | jq . 2>/dev/null || echo "Response received (jq not available for formatting)"
else
    echo "❌ RPC endpoint not responding"
fi

echo ""

# Show recent logs
echo "📝 Recent Logs (last 20 lines):"
if docker logs nano-rpc-proxy 2>/dev/null | tail -20; then
    echo ""
else
    echo "❌ Could not retrieve logs"
fi

echo ""
echo "🔗 Service should be available at:"
echo "   - Health: http://localhost:3000/health"
echo "   - RPC:    http://localhost:3000/"
echo "   - Via nginx: http://$(hostname -I | awk '{print $1}')/"