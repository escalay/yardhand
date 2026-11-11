#!/usr/bin/env bash
# The Helm chart end to end, on the cluster kubectl points at (CI: kind; locally any, OrbStack's for one): the last
# release is installed with real data, upgraded to the image under test, then upgraded to a version that dies after
# migrating. `helm rollback` puts the old version back, and it must come up with the data from before by itself.
# The newer versions are the image under test with another version number. Set GATEWAY_IMAGE; HELM names another helm.
set -euo pipefail
: "${GATEWAY_IMAGE:?set GATEWAY_IMAGE to the image to test}"
root="$(cd "$(dirname "$0")/.." && pwd)"
helm="${HELM:-helm}"
ns=yardhand-smoke
release=yh
port="${GATEWAY_PORT:-8097}"
base="http://localhost:$port"
# The last release that is out: asked of the tags, since on a release's own pull request the version in this tree is
# one that isn't published yet
from="${UPGRADE_FROM:-$(git ls-remote --tags --refs https://github.com/escalay/yardhand.git 'v*' | sed 's|.*refs/tags/v||' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)}"
[ -n "$from" ] || { echo "helm: couldn't list the published releases" >&2; exit 1; }
forward=
cleanup() {
  [ -z "$forward" ] || kill "$forward" 2>/dev/null || true
  "$helm" uninstall "$release" -n "$ns" >/dev/null 2>&1 || true
  kubectl delete namespace "$ns" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() {
  echo "helm: $*" >&2
  kubectl -n "$ns" get pods >&2 || true
  kubectl -n "$ns" logs "deploy/$release" --tail 40 >&2 || true
  exit 1
}

# VERSION [LINE]: the image under test as VERSION (with LINE run after the database opens), where the cluster finds it
image() {
  {
    echo "FROM $GATEWAY_IMAGE"
    echo "RUN sed -i \"s/VERSION = '[0-9.]*'/VERSION = '$1'/\" src/version.ts"
    [ -z "${2:-}" ] || echo "RUN sed -i \"s|^const db = await openDb.*|&; $2|\" src/server.ts"
  } | docker buildx build --builder "$(docker context show)" --load -q -t "yardhand-helm:$1" - >/dev/null
  case "$(kubectl config current-context)" in
    kind-*) kind load docker-image "yardhand-helm:$1" --name "$(kubectl config current-context | sed 's/^kind-//')" >/dev/null 2>&1 ;;
  esac
}
image 98.0.0
image 98.1.0 "await db.run('create table left_by_a_failed_update (x)'); process.exit(1)"

# deploy REPOSITORY TAG [SECONDS]: install or upgrade to that image and wait for it to be ready
deploy() {
  "$helm" upgrade --install "$release" "$root/deploy/helm/yardhand" -n "$ns" --create-namespace \
    --set image.repository="$1" --set image.tag="$2" --set publicHost="$base" \
    --set env.GATEWAY_TELEMETRY=off --set env.GATEWAY_UPDATE_CHECK=off --wait --timeout "${3:-180}s" >/dev/null 2>&1
}
# A pod that was replaced takes its port-forward with it
reach() {
  [ -z "$forward" ] || kill "$forward" 2>/dev/null || true
  kubectl -n "$ns" port-forward "svc/$release" "$port:80" >/dev/null 2>&1 &
  forward=$!
  for _ in $(seq 1 30); do curl -fsS -o /dev/null "$base/api/health" 2>/dev/null && return 0; sleep 1; done
  fail "the gateway isn't reachable through its service"
}
version() { curl -fsS --max-time 5 "$base/api/health" | jq -r .version; }
upstream() { curl -fsS "$base/api/upstreams" "${auth[@]}" | jq -r --arg id "$1" '[.. | objects | select(.id? == $id)] | length'; }
connect() {
  curl -fsS -o /dev/null -X POST "$base/api/upstreams" "${auth[@]}" -H 'content-type: application/json' \
    -d "{\"id\":\"$1\",\"kind\":\"sample\",\"title\":\"$1\",\"auth\":{\"type\":\"none\"}}" || fail "couldn't connect $1"
}

kubectl delete namespace "$ns" --wait >/dev/null 2>&1 || true
deploy ghcr.io/escalay/yardhand "$from" || fail "release $from didn't install"
reach
user=$(kubectl -n "$ns" exec "deploy/$release" -- id -u)
[ "$user" != 0 ] || fail "the pod runs as root"
code=$(kubectl -n "$ns" logs "deploy/$release" | grep -o 'Setup code  [A-Z0-9-]*' | tail -1 | awk '{print $3}')
key=$(curl -fsS -X POST "$base/api/session/claim" -H 'content-type: application/json' -H "origin: $base" \
  -d "{\"code\":\"$code\"}" | jq -r .key)
case "$key" in gw_owner_*) ;; *) fail "the claim gave no owner key" ;; esac
auth=(-H "authorization: Bearer $key")
connect sample
echo "helm: release $from installed, claimed and in use, as user $user with a read-only filesystem"

deploy yardhand-helm 98.0.0 || fail "the upgrade to this build didn't come up"
reach
[ "$(version)" = 98.0.0 ] || fail "after the upgrade it answers $(version)"
[ "$(upstream sample)" -ge 1 ] || fail "the connection made on $from is gone, or the owner key no longer opens it"
updates=$(curl -fsS "$base/api/system/updates" "${auth[@]}")
[ "$(echo "$updates" | jq -r .how)" = manual ] || fail "on Kubernetes the gateway says an update is done by $(echo "$updates" | jq -r .how)"
echo "$updates" | jq -r .manual | grep -q '^helm upgrade ' || fail "the commands to update aren't Helm's: $(echo "$updates" | jq -r .manual)"
connect later
echo "helm: release $from → this build: its data migrated, and Settings gives the helm command to update"

deploy yardhand-helm 98.1.0 90 && fail "a version that dies at start was reported as up"
"$helm" rollback "$release" -n "$ns" --wait --timeout 180s >/dev/null 2>&1 || fail "helm rollback didn't bring the old version back"
reach
[ "$(version)" = 98.0.0 ] || fail "after the rollback it answers $(version)"
kubectl -n "$ns" logs "deploy/$release" | grep -q 'never came up' || fail "the old version didn't say it took the data back"
[ "$(kubectl -n "$ns" exec "deploy/$release" -- node -e "const {DatabaseSync} = require('node:sqlite'); console.log(new DatabaseSync('/state/state.sqlite', {readOnly: true}).prepare(\"select count(*) as n from sqlite_master where name = 'left_by_a_failed_update'\").get().n)")" = 0 ] \
  || fail "the data still carries what the failed version wrote"
[ "$(upstream later)" -ge 1 ] || fail "the data from before the failed upgrade is gone"
echo "helm: a 98.1.0 that dies after migrating, then helm rollback: 98.0.0 is back with the data from before"
