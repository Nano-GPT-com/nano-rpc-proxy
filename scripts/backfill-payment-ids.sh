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

if [[ "$KV_REST_API_URL" != http* ]]; then
  echo "KV_REST_API_URL looks wrong (expected https://...): $KV_REST_API_URL" >&2
fi

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
  local url_lower="${KV_URL}/scan/${cursor}?match=$(urlenc "$pattern")&count=${SCAN_COUNT}"
  local url_upper="${KV_URL}/SCAN/${cursor}?match=$(urlenc "$pattern")&count=${SCAN_COUNT}"

  if [ "${DEBUG:-0}" -ne 0 ]; then
    echo "SCAN url (lowercase): $url_lower" >&2
  fi

  # try lowercase first, then uppercase
  resp="$(curl -s -w '\\n%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$url_lower")"
  body="$(echo "$resp" | head -n-1)"
  code="$(echo "$resp" | tail -n1)"
  if [ "$code" != "200" ]; then
    if [ "${DEBUG:-0}" -ne 0 ]; then
      echo "Lowercase scan returned $code, body: $body" >&2
      echo "Retrying uppercase: $url_upper" >&2
    fi
    resp="$(curl -s -w '\\n%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$url_upper")"
    body="$(echo "$resp" | head -n-1)"
    code="$(echo "$resp" | tail -n1)"
    if [ "$code" != "200" ]; then
      echo "SCAN failed with HTTP $code" >&2
      echo "$body" >&2
      return 1
    fi
  fi
  echo "$body"
}

hgetall() {
  local key="$1"
  local url_lower="${KV_URL}/hgetall/$(urlenc "$key")"
  local url_upper="${KV_URL}/HGETALL/$(urlenc "$key")"
  for u in "$url_lower" "$url_upper"; do
    resp="$(curl -s -w '\\n%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$u")"
    body="$(echo "$resp" | head -n-1)"
    code="$(echo "$resp" | tail -n1)"
    [ "$code" = "200" ] && { echo "$body"; return; }
  done
  echo "HGETALL failed for $key" >&2
  return 1
}

hset_payment() {
  local key="$1" pid="$2"
  local url_lower="${KV_URL}/hset/$(urlenc "$key")"
  local url_upper="${KV_URL}/HSET/$(urlenc "$key")"
  local payload
  payload="$(printf '[\"paymentId\",\"%s\"]' "$pid")"
  for u in "$url_lower" "$url_upper"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" -d "$payload" "$u")"
    [ "$code" = "200" ] && return
  done
  echo "HSET failed for $key" >&2
  return 1
}

get_status() {
  local key="$1"
  local url_lower="${KV_URL}/get/$(urlenc "$key")"
  local url_upper="${KV_URL}/GET/$(urlenc "$key")"
  for u in "$url_lower" "$url_upper"; do
    resp="$(curl -s -w '\\n%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$u")"
    body="$(echo "$resp" | head -n-1)"
    code="$(echo "$resp" | tail -n1)"
    [ "$code" = "200" ] && { echo "$body"; return; }
  done
  echo "GET failed for $key" >&2
  return 1
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
