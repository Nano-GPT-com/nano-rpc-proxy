#!/bin/bash

# Rate Limiting Test Script for Nano RPC Proxy
# This script tests that rate limiting is properly enforced

set -e

ENDPOINT=${1:-https://rpc.nano-gpt.com}
EXPECTED_BURST=20
TEST_SECONDS=30

echo "🧪 Testing rate limiting on Nano RPC Proxy"
echo "📍 Endpoint: $ENDPOINT"
echo "⏱️  Test duration: $TEST_SECONDS seconds"
echo ""

# Counters
SUCCESS=0
RATE_LIMITED=0
ERRORS=0

# Function to make a request
make_request() {
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$ENDPOINT" \
        -H "Content-Type: application/json" \
        -d '{"action": "version"}' 2>/dev/null || echo "000")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    case $HTTP_CODE in
        200)
            ((SUCCESS++))
            echo -n "✅"
            ;;
        429)
            ((RATE_LIMITED++))
            echo -n "🚫"
            ;;
        *)
            ((ERRORS++))
            echo -n "❌"
            ;;
    esac
}

# Start time
START_TIME=$(date +%s)
REQUEST_COUNT=0

echo "Sending requests (✅=success, 🚫=rate limited, ❌=error):"

# Send requests for the test duration
while [ $(($(date +%s) - START_TIME)) -lt $TEST_SECONDS ]; do
    make_request
    ((REQUEST_COUNT++))
    
    # Print newline every 50 requests
    if [ $((REQUEST_COUNT % 50)) -eq 0 ]; then
        echo " ($REQUEST_COUNT)"
    fi
    
    # Small delay to avoid overwhelming the connection
    sleep 0.05
done

echo " ($REQUEST_COUNT)"
echo ""

# Calculate totals
TOTAL=$((SUCCESS + RATE_LIMITED + ERRORS))

echo "📊 Test Results:"
echo "────────────────────────────────────────"
echo "Total requests sent: $TOTAL"
echo "✅ Successful: $SUCCESS"
echo "🚫 Rate limited: $RATE_LIMITED"
echo "❌ Errors: $ERRORS"
echo "────────────────────────────────────────"
echo ""

# Analyze results
if [ $RATE_LIMITED -gt 0 ]; then
    echo "✅ Rate limiting is ACTIVE and working properly!"
    echo "   - Allowed $SUCCESS requests before limiting"
    echo "   - Burst allowance appears to be ~$SUCCESS requests"
elif [ $SUCCESS -ge $EXPECTED_BURST ]; then
    echo "⚠️  WARNING: Rate limiting might not be working!"
    echo "   - Sent $SUCCESS requests without being rate limited"
    echo "   - Expected to be rate limited after ~$EXPECTED_BURST requests"
else
    echo "❓ Inconclusive: Not enough requests to trigger rate limiting"
    echo "   - Try running the test for longer"
fi

# Test with API key (if provided)
if [ ! -z "$2" ]; then
    echo ""
    echo "🔑 Testing with API key..."
    
    API_SUCCESS=0
    for i in {1..30}; do
        RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$ENDPOINT" \
            -H "Content-Type: application/json" \
            -H "X-API-Key: $2" \
            -d '{"action": "version"}' 2>/dev/null || echo "000")
        
        HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
        
        if [ "$HTTP_CODE" = "200" ]; then
            ((API_SUCCESS++))
        fi
    done
    
    echo "   - Sent 30 requests with API key"
    echo "   - Success: $API_SUCCESS/30"
    
    if [ $API_SUCCESS -eq 30 ]; then
        echo "   - ✅ API key bypasses rate limiting as expected"
    else
        echo "   - ❌ API key requests were limited (unexpected)"
    fi
fi