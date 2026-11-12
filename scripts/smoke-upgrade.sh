#!/usr/bin/env bash
# Updates end to end, as an owner gets them. The last release runs from the compose file with real data and is
# updated to the image under test, so its migrations meet data an older version wrote. Then the owner asks for a newer
# version through the API and the updater installs it; then one that dies after migrating, and the old version,
# compose file and data must be back; last, the updater is switched off. The newer versions are the image under test
# with another version number, pushed to a registry on this machine; only the signature check is replaced, since
# nobody signed them. Before that, every older release that can still update in one step (deploy/release.json's
# upgradeFrom and up) is updated to the image under test too, with data in it. CI runs it on every change; locally,
# set GATEWAY_IMAGE (and UPGRADE_FROM to start from one release only).
# UPGRADE_HTTPS=1 runs it all with Caddy in front (`--profile https`, ports 80 and 443 on this machine), as a server
# started from deploy/cloud-init.yaml with a host name runs, and asks everything through the proxy.
set -euo pipefail
: "${GATEWAY_IMAGE:?set GATEWAY_IMAGE to the image to test}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
registry=yardhand-upgrade-registry
repo=localhost:5598/yardhand
export COMPOSE_PROJECT_NAME=yardhand-upgrade
# The releases that are out, oldest first: asked of the tags, since on a release's own pull request the version in
# this tree is one that isn't published yet
published=$(git ls-remote --tags --refs https://github.com/escalay/yardhand.git 'v*' | sed 's|.*refs/tags/v||' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V)
last=$(echo "$published" | tail -n 1)
[ -n "$last" ] || { echo "upgrade: couldn't list the published releases" >&2; exit 1; }
# UPGRADE_OLDER=skip leaves the older releases to someone else (CI runs each as its own job, side by side)
if [ -z "${UPGRADE_FROM:-}" ] && [ "${UPGRADE_OLDER:-run}" = run ]; then
  least=$(jq -r .upgradeFrom "$root/deploy/release.json")
  # Every release from the oldest that updates in one step up to the one before the last; the last gets the full run
  for older in $(echo "$published" | awk -v least="$least" -v last="$last" '
        function key(v, p) { split(v, p, "."); return p[1] * 1000000 + p[2] * 1000 + p[3] }
        key($0) >= key(least) && key($0) < key(last)'); do
    UPGRADE_FROM="$older" UPGRADE_LEGS=first "$0"
  done
fi
port="${GATEWAY_PORT:-8098}"
under_test="$GATEWAY_IMAGE"
# Out of this shell: compose would read them here and the updater, starting from the folder, would not
unset GATEWAY_PORT GATEWAY_IMAGE
base="http://localhost:${port}"
profile=()
if [ -n "${UPGRADE_HTTPS:-}" ]; then
  base="https://localhost"
  profile=(--profile https)
  # Caddy signs localhost with its own authority, which nothing here trusts
  curl() { command curl -k "$@"; }
fi
updater_image=$(sed -n 's/^ *image: \(ghcr.io\/escalay\/updater:.*\)$/\1/p' "$root/deploy/compose/docker-compose.yml")
cleanup() {
  (cd "$work" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  docker rm -f "$registry" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "upgrade: $*" >&2; (cd "$work" && docker compose logs --tail 60 gateway updater caddy >&2) || true; exit 1; }

docker rm -f "$registry" >/dev/null 2>&1 || true
docker run -d --name "$registry" -p 127.0.0.1:5598:5000 registry:2 >/dev/null
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://localhost:5598/v2/ && break; sleep 1; done

# The updater as released, with cosign saying yes
mkdir "$work/updater" "$work/releases"
printf '#!/bin/sh\nexit 0\n' > "$work/updater/cosign"
printf 'FROM %s\nCOPY --chmod=755 cosign /usr/local/bin/cosign\n' "${UPDATER_BASE:-$updater_image}" > "$work/updater/Dockerfile"
# Docker's own builder, named after the context: one in a container (CI's) sees no local image and keeps what it builds
build() { docker buildx build --builder "$(docker context show)" --load -q "$@" >/dev/null; }
build -t yardhand-upgrade-updater "$work/updater"

from="${UPGRADE_FROM:-$last}"
docker pull -q "ghcr.io/escalay/yardhand:$from" >/dev/null || fail "release $from, the one to update from, couldn't be pulled"
compose_for() { sed "s|ghcr.io/escalay/yardhand:[0-9.]*}|$repo:$1}|" "$root/deploy/compose/docker-compose.yml"; }

# release VERSION [LINE]: the image under test as VERSION (with LINE run after the database opens), and its files
release() {
  local version=$1 dir="$work/releases/v$1" digest
  {
    echo "FROM $under_test"
    echo "RUN sed -i \"s/VERSION = '[0-9.]*'/VERSION = '$version'/\" src/version.ts"
    [ -z "${2:-}" ] || echo "RUN sed -i \"s|^const db = await openDb.*|&; $2|\" src/server.ts"
  } | build -t "$repo:$version" -
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
docker tag "ghcr.io/escalay/yardhand:$from" "$repo:$from" && docker push -q "$repo:$from" >/dev/null
release 98.0.0
# The later versions only for the full run: a first leg stops before it needs them
if [ "${UPGRADE_LEGS:-all}" = all ]; then
  release 98.1.0
  release 98.2.0 "await db.run('create table left_by_a_failed_update (x)'); process.exit(1)"
fi

compose_for "$from" > "$work/docker-compose.yml"
# Every setting is in .env: the updater starts the new version from this folder, not from this shell
printf 'GATEWAY_PORT=%s\nGATEWAY_TELEMETRY=off\nGATEWAY_UPDATE_CHECK=off\n' "$port" > "$work/.env"
[ -z "${UPGRADE_HTTPS:-}" ] || echo 'PUBLIC_HOST=localhost' >> "$work/.env"
# The owner's own compose file beside the release's: the updater keeps it through an update
cat > "$work/docker-compose.override.yml" <<YAML
services:
  # Health asked for every 5 seconds, not 30, so a version that never comes up is known in seconds
  gateway:
    healthcheck:
      interval: 5s
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
docker compose "${profile[@]}" up -d >/dev/null 2>"$work/up.log" || fail "the project didn't start: $(cat "$work/up.log")"
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
version() { curl -fsS --max-time 5 "$base/api/health" 2>/dev/null | jq -r .version; }
upstream() { curl -fsS "$base/api/upstreams" "${auth[@]}" | jq -r --arg id "$1" '[.. | objects | select(.id? == $id)] | length'; }
table() { docker compose exec -T gateway node -e "const {DatabaseSync} = require('node:sqlite'); console.log(new DatabaseSync('/state/state.sqlite', {readOnly: true}).prepare(\"select count(*) as n from sqlite_master where name = 'left_by_a_failed_update'\").get().n)"; }
status() { docker compose exec -T updater cat /state/updates/status.json 2>/dev/null || echo '{}'; }
mine() { [ "$(ls -ln docker-compose.yml | awk '{print $3}')" = "$(id -u)" ] || fail "the compose file no longer belongs to its owner"; }

# The last release has no Updates page, so its request is left the way a newer gateway leaves one
docker compose exec -T updater sh -c "jq -n '{id: \"from-$from\", version: \"98.0.0\", at: \"now\"}' > /state/updates/request.json"
for _ in $(seq 1 180); do
  case "$(status | jq -r '"\(.id) \(.state)"')" in "from-$from done" | "from-$from failed" | "from-$from refused") break ;; esac
  sleep 1
done
[ "$(status | jq -r .state)" = done ] || fail "release $from → this build ended as $(status | jq -c .)"
[ "$(version)" = 98.0.0 ] || fail "after the update from $from it answers $(version)"
[ "$(updates | jq -r .current)" = 98.0.0 ] || fail "the owner key from $from no longer opens the updated gateway"
[ "$(upstream sample)" -ge 1 ] || fail "the connection made on $from is gone"
grep -q "$repo:98.0.0}" docker-compose.yml || fail "the compose file isn't the new release's"
mine
echo "upgrade: release $from → this build: its data migrated, the owner and the connection are there"
[ "${UPGRADE_LEGS:-all}" = all ] || exit 0

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

ask 98.1.0
[ "$(updates | jq -r '.status.state')" = done ] || fail "98.0.0 → 98.1.0 ended as $(updates | jq -c .status)"
[ "$(version)" = 98.1.0 ] || fail "after the update it answers $(version)"
docker compose exec -T gateway test -f /state/backups/before-98.1.0.sqlite || fail "no copy of the data from before the update was kept"
echo "upgrade: 98.0.0 → 98.1.0 asked through the API; a copy of the data from before is kept"

curl -fsS -o /dev/null -X POST "$base/api/upstreams" "${auth[@]}" -H 'content-type: application/json' \
  -d '{"id":"later","kind":"sample","title":"Made after the first update","auth":{"type":"none"}}' || fail "couldn't write after the update"
ask 98.2.0
[ "$(updates | jq -r '.status.state')" = failed ] || fail "the bad 98.2.0 ended as $(updates | jq -c .status)"
[ "$(version)" = 98.1.0 ] || fail "after the rollback it answers $(version)"
grep -q "$repo:98.1.0}" docker-compose.yml || fail "after the rollback the compose file isn't the old one"
mine
[ "$(table)" = 0 ] || fail "the data still carries what the failed version wrote"
[ "$(upstream later)" -ge 1 ] || fail "the data from before the failed update is gone"
echo "upgrade: 98.1.0 → a 98.2.0 that dies after migrating: rolled back ($(updates | jq -r .status.detail))"

# Without the updater: the container is gone and the owner is shown the commands
echo 'GATEWAY_UPDATER=0' >> .env
docker compose "${profile[@]}" up -d >/dev/null 2>&1
[ -z "$(docker compose ps -q updater)" ] || fail "GATEWAY_UPDATER=0 left the updater running"
# The gateway counts an updater as gone 90 seconds after its last sign of life (a unit test holds that); taking the
# sign away here saves the wait
docker compose exec -T gateway rm -f /state/updates/updater.json
for _ in $(seq 1 100); do [ "$(updates | jq -r .how)" = manual ] && break; sleep 1; done
[ "$(updates | jq -r .how)" = manual ] || fail "without the updater the gateway still says $(updates | jq -r .how)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/system/updates/requests" "${auth[@]}" -H 'content-type: application/json' -d '{"version":"98.2.0"}')" = 409 ] \
  || fail "without the updater a request wasn't refused"
echo "upgrade: GATEWAY_UPDATER=0 removes the updater, and the gateway then gives the commands"
