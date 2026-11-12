#!/usr/bin/env bash
# Decides which of CI's slow jobs a run needs, so a change is tested by what it could break and nothing is tested
# twice. Prints one `name=value` per line: e2e, compose, kubernetes (true or false) and older (which older releases
# the upgrade test starts from: none, some, all). .github/workflows/ci.yml reads them; scripts/ci-plan.test.sh
# holds the map to its cases.
#
#   EVENT    pull_request, push, schedule or workflow_dispatch
#   BRANCH   the branch the run is for
#   TESTED   true on a push whose exact commit already passed these jobs in its pull request
#   stdin    for a pull request, its files: one per line as `path<TAB>data`, where data is true when the change to
#            that file adds a migration or a table
set -euo pipefail
event="${EVENT:?}" branch="${BRANCH:-}" tested="${TESTED:-false}"
say() { printf 'e2e=%s\ncompose=%s\nkubernetes=%s\nolder=%s\n' "$1" "$2" "$3" "$4"; exit 0; }

# A release's own pull request changes version numbers on code main just tested: one real update is enough
case "$branch" in release-please--*) say false true false none ;; esac

case "$event" in
  # The nightly run and a run asked for by hand test everything, from every release
  schedule | workflow_dispatch) say true true true all ;;
  push) if [ "$tested" = true ]; then say false false false none; else say true true true some; fi ;;
esac

e2e=false compose=false kubernetes=false older=none seen=false
while IFS=$'\t' read -r path data; do
  [ -n "$path" ] || continue
  seen=true
  case "$path" in
    # Prose, and the typed client for scripts: the gate covers them
    *.md | packages/client/*) ;;
    apps/web/*) e2e=true ;;
    deploy/helm/* | scripts/smoke-helm.sh) kubernetes=true ;;
    deploy/compose/* | deploy/release.json | deploy/cloud-init.yaml | scripts/smoke-compose.sh | scripts/smoke-upgrade.sh)
      compose=true older=some ;;
    # What the image is made of, on every kind of install
    apps/gateway/Dockerfile | apps/gateway/container/*) compose=true kubernetes=true older=some ;;
    # Code that decides what happens to data at a start, an update or a restore
    apps/gateway/src/features/instance/* | apps/gateway/src/features/backups/* | apps/gateway/src/features/updates/* | apps/gateway/src/kit/db/*)
      e2e=true compose=true kubernetes=true older=some ;;
    # Other gateway code: older releases only when it adds a migration
    apps/gateway/*)
      e2e=true compose=true
      [ "$data" != true ] || older=some ;;
    # Anything else (the workflows, the lockfile, root settings, a new folder) could touch everything
    *) say true true true some ;;
  esac
done
# No list of files is no reason to test less
[ "$seen" = true ] || say true true true some
say "$e2e" "$compose" "$kubernetes" "$older"
