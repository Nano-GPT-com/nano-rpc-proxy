#!/usr/bin/env sh

set -e

if [ -z "$KV_REST_API_URL" ] || [ -z "$KV_REST_API_TOKEN" ]; then
  echo "KV_REST_API_URL and KV_REST_API_TOKEN are required" >&2
  exit 1
fi

TICKER=${TICKER:-zano}
ADDRESS=${ADDRESS:-}
TXID=${TXID:-}
JOB_ID=${JOB_ID:-$TXID}
EXPECTED_AMOUNT=${EXPECTED_AMOUNT:-}
MIN_CONF=${MIN_CONF:-}
SESSION_ID=${SESSION_ID:-}
WATCHER_KEY_PREFIX=${WATCHER_KEY_PREFIX:-zano}

if [ -z "$ADDRESS" ] || [ -z "$TXID" ]; then
  echo "ADDRESS and TXID are required" >&2
  exit 1
fi

KEY="${WATCHER_KEY_PREFIX}:deposit:${TICKER}:${JOB_ID}"
VALUE=$(cat <<EOF
{
  "ticker": "${TICKER}",
  "address": "${ADDRESS}",
  "txId": "${TXID}",
  "jobId": "${JOB_ID}",
  "expectedAmount": "${EXPECTED_AMOUNT}",
  "minConf": "${MIN_CONF}",
  "sessionId": "${SESSION_ID}",
  "createdAt": "$(date -Iseconds)"
}
EOF
)

URL="${KV_REST_API_URL}/set/${KEY}/$(printf '%s' "$VALUE" | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read(), safe=""))')"

curl -s -X GET "$URL" -H "Authorization: Bearer ${KV_REST_API_TOKEN}" -o /tmp/resp
echo "Set $KEY"
cat /tmp/resp
echo ""
