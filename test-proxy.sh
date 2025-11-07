#!/bin/bash

# Nano RPC Proxy Test Script
# Tests both allowed and blocked commands with and without API key

PROXY_URL="${1:-http://localhost:3000}"
API_KEY="5e3ff8205b57fa3495bde592f07a0a06b395f97997555a8ce104347f651d63eb"

echo "Testing Nano RPC Proxy at: $PROXY_URL"
echo "========================================"

# Detect jq availability for pretty-printing
if command -v jq >/dev/null 2>&1; then
  HAS_JQ=true
else
  HAS_JQ=false
  echo "⚠️  jq not found - responses will be printed raw. Install it for nicer output (e.g. sudo apt-get install -y jq)."
fi

format_json() {
  if [ "$HAS_JQ" = true ]; then
    jq .
  else
    cat
  fi
}

# Test 1: Health check
echo -e "\n1. Testing health endpoint:"
curl -s "$PROXY_URL/health" | format_json

# Test 2: Allowed command without API key
echo -e "\n2. Testing allowed command (block_count) without API key:"
curl -s -X POST "$PROXY_URL" \
  -H "Content-Type: application/json" \
  -d '{"action": "block_count"}' | format_json

# Test 3: Another allowed command without API key
echo -e "\n3. Testing allowed command (version) without API key:"
curl -s -X POST "$PROXY_URL" \
  -H "Content-Type: application/json" \
  -d '{"action": "version"}' | format_json

# Test 4: Blocked command without API key
echo -e "\n4. Testing blocked command (send) without API key (should fail):"
curl -s -X POST "$PROXY_URL" \
  -H "Content-Type: application/json" \
  -d '{"action": "send"}' | format_json

# Test 5: Blocked command with API key
echo -e "\n5. Testing blocked command (wallet_create) with API key (should work):"
curl -s -X POST "$PROXY_URL" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"action": "wallet_create"}' | format_json

# Test 6: Test key_create (safe utility command)
echo -e "\n6. Testing safe utility command (key_create) without API key:"
curl -s -X POST "$PROXY_URL" \
  -H "Content-Type: application/json" \
  -d '{"action": "key_create"}' | format_json

echo -e "\n========================================"
echo "Test completed!"
