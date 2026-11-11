#!/usr/bin/env bash
# An update end to end, as an owner gets it: the image under test runs from the compose file with real data, the
# owner asks for a newer version through the API, and the updater installs it. Then a newer version that dies after
# migrating: the old version, compose file and data must be back. The newer versions are this same image with another
# version number (and, for the bad one, a start that fails), pushed to a registry on this machine; only the signature
# check is replaced, since nobody signed them. CI runs it on every change; locally, set GATEWAY_IMAGE.
set -euo pipefail
: "${GATEWAY_IMAGE:?set GATEWAY_IMAGE to the image to test}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
registry=yardhand-upgrade-registry
repo=localhost:5598/yardhand
export COMPOSE_PROJECT_NAME=yardhand-upgrade
port="${GATEWAY_PORT:-8098}"
unset GATEWAY_PORT
base="http://localhost:${port}"
updater_image=$(sed -n 's/^ *image: \(ghcr.io\/escalay\/updater:.*\)$/\1/p' "$root/deploy/compose/docker-compose.yml")
cleanup() {
  (cd "$work" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  docker rm -f "$registry" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "upgrade: $*" >&2; (cd "$work" && docker compose logs --tail 60 gateway updater >&2) || true; exit 1; }

docker rm -f "$registry" >/dev/null 2>&1 || true
docker run -d --name "$registry" -p 127.0.0.1:5598:5000 registry:2 >/dev/null
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://localhost:5598/v2/ && break; sleep 1; done

# The updater as released, with cosign saying yes
mkdir "$work/updater" "$work/releases"
printf '#!/bin/sh\nexit 0\n' > "$work/updater/cosign"
printf 'FROM %s\nCOPY --chmod=755 cosign /usr/local/bin/cosign\n' "${UPDATER_BASE:-$updater_image}" > "$work/updater/Dockerfile"
docker build -q -t yardhand-upgrade-updater "$work/updater" >/dev/null

from=$(docker run --rm --entrypoint sed "$GATEWAY_IMAGE" -n "s/.*VERSION = '\([0-9.]*\)'.*/\1/p" src/version.ts)
[ -n "$from" ] || fail "couldn't read the version of $GATEWAY_IMAGE"
compose_for() { sed "s|ghcr.io/escalay/yardhand:[0-9.]*}|$repo:$1}|" "$root/deploy/compose/docker-compose.yml"; }

# release VERSION [LINE]: the image under test as VERSION (with LINE run after the database opens), and its files
release() {
  local version=$1 dir="$work/releases/v$1" digest
  {
    echo "FROM $GATEWAY_IMAGE"
    echo "RUN sed -i \"s/VERSION = '[0-9.]*'/VERSION = '$version'/\" src/version.ts"
    [ -z "${2:-}" ] || echo "RUN sed -i \"s|^const db = await openDb.*|&; $2|\" src/server.ts"
  } | docker build -q -t "$repo:$version" - >/dev/null
  docker push -q "$repo:$version" >/dev/null
  digest=$(docker image inspect "$repo:$version" --format '{{ index .RepoDigests 0 }}' | sed 's/.*@//')
  mkdir -p "$dir"
  compose_for "$version" > "$dir/docker-compose.yml"
  jq -n --arg v "$version" --arg from "$(jq -r .upgradeFrom "$root/deploy/release.json")" --arg image "$repo@$digest" \
    --arg sha "$(shasum -a 256 "$dir/docker-compose.yml" | cut -d' ' -f1)" \
    '{version: $v, upgradeFrom: $from, image: $image, compose: {file: "docker-compose.yml", sha256: $sha}}' > "$dir/release.json"
  echo '{}' > "$dir/yardhand.intoto.jsonl"
  docker rmi -f "$repo:$version" >/dev/null 2>&1 || true
}
docker tag "$GATEWAY_IMAGE" "$repo:$from" && docker push -q "$repo:$from" >/dev/null
release 98.0.0
release 98.1.0 "await db.run('create table left_by_a_failed_update (x)'); process.exit(1)"

compose_for "$from" > "$work/docker-compose.yml"
# Every setting is in .env: the updater starts the new version from this folder, not from this shell
printf 'GATEWAY_PORT=%s\nGATEWAY_TELEMETRY=off\nGATEWAY_UPDATE_CHECK=off\n' "$port" > "$work/.env"
# The owner's own compose file beside the release's: the updater keeps it through an update
cat > "$work/docker-compose.override.yml" <<YAML
services:
  updater:
    image: yardhand-upgrade-updater
    environment:
      UPDATER_IMAGE: $repo
      UPDATER_RELEASES: http://releases/releases
      UPDATER_TIMEOUT: "60"
      UPDATER_POLL: "2"
  releases:
    image: busybox:1.37
    command: httpd -f -p 80 -h /www
    volumes:
      - ./releases:/www/releases:ro
YAML
cd "$work"
docker compose up -d >/dev/null 2>"$work/up.log" || fail "the project didn't start: $(cat "$work/up.log")"
healthy() { for _ in $(seq 1 60); do curl -fsS -o /dev/null "$base/api/health" && return 0; sleep 1; done; return 1; }
healthy || fail "never answered /api/health"
code=$(docker compose logs gateway | grep -o 'Setup code  [A-Z0-9-]*' | tail -1 | awk '{print $3}')
key=$(curl -fsS -X POST "$base/api/session/claim" -H 'content-type: application/json' -H "origin: $base" \
  -d "{\"code\":\"$code\"}" | jq -r .key)
case "$key" in gw_owner_*) ;; *) fail "the claim gave no owner key" ;; esac
auth=(-H "authorization: Bearer $key")
curl -fsS -o /dev/null -X POST "$base/api/upstreams" "${auth[@]}" -H 'content-type: application/json' \
  -d '{"id":"sample","kind":"sample","title":"Sample tools","auth":{"type":"none"}}' || fail "couldn't connect the sample tools"

updates() { curl -fsS --max-time 5 "$base/api/system/updates" "${auth[@]}" 2>/dev/null || echo '{}'; }
for _ in $(seq 1 30); do [ "$(updates | jq -r .updater.present)" = true ] && break; sleep 1; done
[ "$(updates | jq -r .how)" = updater ] || fail "the gateway doesn't see the updater beside it"
# ask VERSION: the owner's click; waits for the run to end, through the restart
ask() {
  local before; before=$(updates | jq -r '.history | length')
  [ "$(curl -fsS -o /dev/null -w '%{http_code}' -X POST "$base/api/system/updates/requests" "${auth[@]}" \
    -H 'content-type: application/json' -d "{\"version\":\"$1\"}")" = 202 ] || fail "the gateway refused the request for $1"
  for _ in $(seq 1 180); do
    [ "$(updates | jq -r '.history | length')" = $((before + 1)) ] && return 0
    sleep 1
  done
  fail "the update to $1 never finished: $(updates | jq -c .status)"
}
tools() { curl -fsS "$base/api/upstreams" "${auth[@]}" | jq -r '[.. | objects | select(.id? == "sample")] | length'; }
table() { docker compose exec -T gateway node -e "const {DatabaseSync} = require('node:sqlite'); console.log(new DatabaseSync('/state/state.sqlite', {readOnly: true}).prepare(\"select count(*) as n from sqlite_master where name = 'left_by_a_failed_update'\").get().n)"; }

ask 98.0.0
[ "$(updates | jq -r '.status.state')" = done ] || fail "$from → 98.0.0 ended as $(updates | jq -c .status)"
[ "$(curl -fsS "$base/api/health" | jq -r .version)" = 98.0.0 ] || fail "after the update it answers $(curl -fsS "$base/api/health")"
[ "$(updates | jq -r .current)" = 98.0.0 ] || fail "the owner key no longer opens the updated gateway"
[ "$(tools)" -ge 1 ] || fail "the connection made before the update is gone"
docker compose exec -T gateway test -f /state/backups/before-98.0.0.sqlite || fail "no copy of the data from before the update was kept"
grep -q "$repo:98.0.0}" docker-compose.yml || fail "the compose file isn't the new release's"
echo "upgrade: $from → 98.0.0 through the API and the updater; the owner, the data and a backup are there"

curl -fsS -o /dev/null -X POST "$base/api/upstreams" "${auth[@]}" -H 'content-type: application/json' \
  -d '{"id":"later","kind":"sample","title":"Made after the first update","auth":{"type":"none"}}' || fail "couldn't write after the update"
ask 98.1.0
[ "$(updates | jq -r '.status.state')" = failed ] || fail "the bad 98.1.0 ended as $(updates | jq -c .status)"
[ "$(curl -fsS "$base/api/health" | jq -r .version)" = 98.0.0 ] || fail "after the rollback it answers $(curl -fsS "$base/api/health")"
grep -q "$repo:98.0.0}" docker-compose.yml || fail "after the rollback the compose file isn't the old one"
[ "$(table)" = 0 ] || fail "the data still carries what the failed version wrote"
[ "$(curl -fsS "$base/api/upstreams" "${auth[@]}" | jq -r '[.. | objects | select(.id? == "later")] | length')" -ge 1 ] || fail "the data from before the failed update is gone"
echo "upgrade: 98.0.0 → a 98.1.0 that dies after migrating: rolled back ($(updates | jq -r .status.detail))"
