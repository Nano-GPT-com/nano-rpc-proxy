#!/usr/bin/env bash

set -euo pipefail

require() {
  if [ -z "${!1:-}" ]; then
    echo "Missing env var $1" >&2
    exit 1
  fi
}

require KV_REST_API_URL
require KV_REST_API_TOKEN
require WATCHER_TICKERS

KV_URL="$KV_REST_API_URL"
TOKEN="$KV_REST_API_TOKEN"
TICKERS="${WATCHER_TICKERS}"
PREFIX="${WATCHER_KEY_PREFIX:-zano}"
SCAN_COUNT="${WATCHER_SCAN_COUNT:-100}"

command -v curl >/dev/null || { echo "curl is required"; exit 1; }
command -v jq >/dev/null || { echo "jq is required"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }

urlenc() {
  python3 - <<'PY' "$1"
import sys, urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
}

checked=0
updated=0
missing=0

scan_once() {
  local pattern="$1" cursor="$2"
  local url="${KV_URL}/SCAN/${cursor}?match=$(urlenc "$pattern")&count=${SCAN_COUNT}"
  if [ "${DEBUG:-0}" -ne 0 ]; then
    echo "SCAN url: $url" >&2
    curl -sSL -D /tmp/scan_headers.$$ -H "Authorization: Bearer ${TOKEN}" "$url" || {
      echo "SCAN failed; status headers:" >&2
      cat /tmp/scan_headers.$$ >&2
      return 1
    }
  else
    curl -fsSL -H "Authorization: Bearer ${TOKEN}" "$url"
  fi
}

hgetall() {
  local key="$1"
  local url="${KV_URL}/HGETALL/$(urlenc "$key")"
  curl -fsSL -H "Authorization: Bearer ${TOKEN}" "$url"
}

hset_payment() {
  local key="$1" pid="$2"
  local url="${KV_URL}/HSET/$(urlenc "$key")"
  curl -fsSL -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(printf '[\"paymentId\",\"%s\"]' "$pid")" \
    "$url" >/dev/null
}

get_status() {
  local key="$1"
  local url="${KV_URL}/GET/$(urlenc "$key")"
  curl -fsSL -H "Authorization: Bearer ${TOKEN}" "$url"
}

for raw in ${TICKERS//,/ }; do
  ticker="$(echo "$raw" | tr '[:upper:]' '[:lower:]')"
  cursor="0"
  pattern="${PREFIX}:deposit:${ticker}:*"
  echo "Scanning ${ticker} with pattern ${pattern}"
  while :; do
    resp="$(scan_once "$pattern" "$cursor")"
    cursor="$(echo "$resp" | jq -r '.cursor')"
    mapfile -t keys < <(echo "$resp" | jq -r '.keys[]?')
    if [ "${#keys[@]}" -eq 0 ]; then
      [ "$cursor" = "0" ] && break || continue
    fi

    for key in "${keys[@]}"; do
      ((checked++))
      job_json="$(hgetall "$key")"
      payment="$(echo "$job_json" | jq -r '.paymentId // .paymentid // empty')"
      txId="$(echo "$job_json" | jq -r '.txId // .txid // empty')"
      if [ -z "$txId" ]; then
        continue
      fi
      if [ -n "$payment" ] && [ "$payment" != "null" ]; then
        continue
      fi

      status_key="${PREFIX}:transaction:status:${ticker}:${txId}"
      status_json="$(get_status "$status_key")"
      status_raw="$(echo "$status_json" | jq -r '.result // empty')"
      paymentId="$(echo "$status_raw" | jq -r '.paymentId // .paymentid // empty' 2>/dev/null || true)"

      if [ -n "$paymentId" ]; then
        hset_payment "$key" "$paymentId"
        ((updated++))
        echo "Backfilled paymentId for ${key} (txId=${txId}, paymentId=${paymentId})"
      else
        ((missing++))
        echo "No paymentId available for ${key} (txId=${txId})"
      fi
    done

    [ "$cursor" = "0" ] && break
  done
done

echo "Backfill complete: checked=${checked}, updated=${updated}, missing=${missing}"
