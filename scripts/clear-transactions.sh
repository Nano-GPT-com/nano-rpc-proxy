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

PREFIX="${WATCHER_KEY_PREFIX:-zano}"
COUNT="${COUNT:-100}"

scan_and_del() {
  local pattern="$1"
  local cursor="0"
  while :; do
    resp="$(curl -s -H "Authorization: Bearer ${KV_REST_API_TOKEN}" \
      "${KV_REST_API_URL}/scan/${cursor}?match=${pattern}&count=${COUNT}")"
    cursor="$(echo "$resp" | jq -r '.cursor')"
    keys=$(echo "$resp" | jq -r '.keys[]?' || true)
    if [ -n "$keys" ]; then
      echo "$keys" | while read -r k; do
        [ -z "$k" ] && continue
        echo "Deleting $k"
        curl -s -H "Authorization: Bearer ${KV_REST_API_TOKEN}" \
          "${KV_REST_API_URL}/del/$(python3 - <<'PY'\nimport sys,urllib.parse\nprint(urllib.parse.quote(sys.stdin.read().strip(), safe=\"\"))\nPY <<<"$k")" >/dev/null
      done
    fi
    [ "$cursor" = "0" ] && break
  done
}

scan_and_del "${PREFIX}:deposit:*"
scan_and_del "${PREFIX}:transaction:status:*"
scan_and_del "${PREFIX}:seen:*"

echo "Cleared deposit, status, and seen keys for prefix '${PREFIX}'."
