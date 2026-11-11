#!/usr/bin/env bash
# The self-hosting path end to end against an image: start the compose file with no settings, read the setup code
# from the log, claim the instance, connect the sample tools and run one, back up, restart, and find the owner still
# there, with the updater beside it. CI runs it on every change; run it locally with GATEWAY_IMAGE set to an image you
# built. It runs in a copy of the compose folder whose .env keeps the instance from calling out.
set -euo pipefail
work="$(mktemp -d)"
cp "$(dirname "$0")/../deploy/compose/docker-compose.yml" "$work/"
printf 'GATEWAY_TELEMETRY=off\nGATEWAY_UPDATE_CHECK=off\n' > "$work/.env"
cd "$work"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-yardhand-smoke}" GATEWAY_PORT="${GATEWAY_PORT:-8099}"
: "${GATEWAY_IMAGE:?set GATEWAY_IMAGE to the image to test}"
base="http://localhost:${GATEWAY_PORT}"
fail() { echo "smoke: $*" >&2; docker compose logs gateway >&2 || true; exit 1; }
healthy() { for _ in $(seq 1 60); do curl -fsS -o /dev/null "$base/api/health" && return 0; sleep 1; done; return 1; }
trap 'docker compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

docker compose up -d
healthy || fail "never answered /api/health"
code=$(docker compose logs gateway | grep -o 'Setup code  [A-Z0-9-]*' | tail -1 | awk '{print $3}')
[ -n "$code" ] || fail "no setup code in the log"
[ "$(curl -fsS "$base/api/session" | jq -r .setup)" = true ] || fail "a new instance isn't waiting for its owner"

key=$(curl -fsS -X POST "$base/api/session/claim" -H 'content-type: application/json' -H "origin: $base" \
  -d "{\"code\":\"$code\"}" | jq -r .key)
case "$key" in gw_owner_*) ;; *) fail "the claim gave no owner key" ;; esac
auth=(-H "authorization: Bearer $key")

curl -fsS -o /dev/null -X POST "$base/api/upstreams" "${auth[@]}" -H 'content-type: application/json' \
  -d '{"id":"sample","kind":"sample","title":"Sample tools","auth":{"type":"none"}}' || fail "couldn't connect the sample tools"
total=$(curl -fsS -X POST "$base/api/calls" "${auth[@]}" -H 'content-type: application/json' \
  -d '{"tool":"sample.roll_dice","arguments":{"count":2}}' | jq -r .result.structuredContent.total)
[ "$total" -ge 2 ] 2>/dev/null || fail "the sample tool didn't run (got $total)"
[ "$(curl -fsS -X POST "$base/api/system/jobs/backup/runs" "${auth[@]}" | jq -r '.jobs[] | select(.name=="backup") | .ok')" = true ] \
  || fail "the backup failed"

updates=$(curl -fsS "$base/api/system/updates" "${auth[@]}")
[ "$(echo "$updates" | jq -r .check)" = false ] || fail "the update check is on, so this test would call out"
for _ in $(seq 1 30); do
  [ "$(curl -fsS "$base/api/system/updates" "${auth[@]}" | jq -r .updater.present)" = true ] && break
  sleep 1
done
[ "$(curl -fsS "$base/api/system/updates" "${auth[@]}" | jq -r .how)" = updater ] || fail "the gateway doesn't see the updater beside it"

docker compose restart gateway >/dev/null
healthy || fail "didn't come back after a restart"
[ "$(curl -fsS -o /dev/null -w '%{http_code}' "$base/api/me" "${auth[@]}")" = 200 ] || fail "the owner was lost on restart"
[ "$(curl -fsS "$base/api/session" | jq -r .setup)" = false ] || fail "setup opened again after a restart"
echo "smoke: claimed, ran a tool, backed up, saw its updater and restarted fine"
