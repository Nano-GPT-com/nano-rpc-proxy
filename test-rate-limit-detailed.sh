#!/bin/bash

# Detailed rate limiting test
ENDPOINT=${1:-https://rpc.nano-gpt.com}

echo "🧪 Detailed rate limiting test for $ENDPOINT"
echo ""

# Test 1: Single request with full output
echo "Test 1: Single request with verbose output"
echo "─────────────────────────────────────────"
curl -v -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d '{"action": "version"}' 2>&1 | grep -E "(HTTP/|< |> )"
echo ""

# Test 2: Burst of requests with status codes
echo "Test 2: Sending 25 requests rapidly..."
echo "─────────────────────────────────────────"

for i in {1..25}; do
    # Get just the HTTP status code
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$ENDPOINT" \
        -H "Content-Type: application/json" \
        -d '{"action": "version"}' 2>&1)
    
    echo "Request $i: HTTP $STATUS"
    
    # If we get rate limited or error, show details
    if [ "$STATUS" != "200" ]; then
        echo "  Getting full response for error..."
        curl -s -i -X POST "$ENDPOINT" \
            -H "Content-Type: application/json" \
            -d '{"action": "version"}' 2>&1 | head -20
        break
    fi
    
    # Small delay
    sleep 0.1
done