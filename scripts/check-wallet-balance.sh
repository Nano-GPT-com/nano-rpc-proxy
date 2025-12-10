#!/usr/bin/env sh

set -e

ZANO_RPC_URL="${ZANO_RPC_URL:-http://127.0.0.1:11212/json_rpc}"
AUTH_HEADER=""

if [ -n "$ZANO_RPC_USER" ]; then
  AUTH_HEADER="-u ${ZANO_RPC_USER}:${ZANO_RPC_PASSWORD}"
fi

curl -s $AUTH_HEADER \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"get_balance","params":{}}' \
  "$ZANO_RPC_URL" | sed 's/\\\\n/\n/g'
