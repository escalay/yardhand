# Self-hosting Yardhand with Docker Compose

One compose file runs the whole product: the API, the MCP server at `/mcp` and the owner's app at `/app`, with its
data in one volume. Caddy is included for HTTPS and is off until you ask for it. You need Docker with Compose v2.24 or
newer; nothing else, and no clone of the repository.

## Start

```sh
mkdir yardhand && cd yardhand
curl -fsSLO https://github.com/escalay/yardhand/releases/latest/download/docker-compose.yml
docker compose up -d               # pulls the image for your machine (amd64 or arm64)
docker compose logs gateway        # shows the setup code
open http://localhost:8080/app     # enter the code, then follow the setup
```

No settings are needed. On its first start Yardhand makes its own keys and prints a one-time setup code in its
log. In the browser, the code makes the instance yours and shows your owner key once; a short guided setup then
checks the instance, connects a first server (or three built-in sample tools) and gives an agent its key.

| Key | Where it lives | Keep it |
|---|---|---|
| The owner key | shown once, when you claim the instance; Yardhand keeps only its fingerprint | in your password manager. It signs you in, and scripts send it as `Authorization: Bearer <key>` |
| The master key | `instance.json` in the data volume, unless `GATEWAY_MASTER_KEY` is set | a copy somewhere else: `docker compose cp gateway:/state/instance.json ./`. It seals every credential you store; without it a backup can’t be opened |
| The OAuth signing key | `instance.json`, unless `OAUTH_SIGNING_KEY` is set | with the master key |

Lost the owner key? `docker compose run --rm -e GATEWAY_SCRIPT=scripts/reset-owner.ts gateway`, then
`docker compose restart gateway`: the log shows a new setup code and the browser asks for it. Connections, agents
and data stay.

Yardhand checks its settings before it starts. If one is wrong it says which, and how to put it right:
`docker compose logs gateway`. To change a setting, copy `.env.example` to `.env`, edit it, and
`docker compose up -d`.

## On a new server

[`deploy/cloud-init.yaml`](../cloud-init.yaml) does the steps above on a fresh Ubuntu or Debian server: paste it as
the user data (cloud-init) when you create the server. It installs Docker, starts the latest release from
`/opt/yardhand`, and leaves a message at login saying where the app is and how to read the setup code. For HTTPS on
your own name, put the name on its `PUBLIC_HOST` line before pasting and point the name's DNS at the server.

## Where it is reached

By default it listens on this machine only. Pick the row that fits, set the lines in `.env` (start from
`.env.example`), then run the command.

| You want | In `.env` | Then |
|---|---|---|
| Only this machine | nothing | `docker compose up -d` → `http://localhost:8080/app` |
| Your home network, plain HTTP | `PUBLIC_HOST=http://nas.local:8080` and `GATEWAY_BIND=0.0.0.0` | `docker compose up -d` |
| The internet, HTTPS by Caddy | `PUBLIC_HOST=gateway.example.test` | `docker compose --profile https up -d` |
| Behind your own proxy or tunnel | `PUBLIC_HOST=gateway.example.test`, and `GATEWAY_BIND=0.0.0.0` if the proxy is on another machine | `docker compose up -d`, and point the proxy at port 8080 |

For HTTPS by Caddy, the name's DNS must point at this machine and ports 80 and 443 must be open; Caddy gets and
renews the certificate. `PUBLIC_HOST` is the address the gateway hands out in links and OAuth redirects, so it has to
be the one people and agents really use: a bare name means HTTPS, a plain-HTTP address is written whole. Another port
on this machine is `GATEWAY_PORT`.

Plain HTTP on a network you don't control sends keys in the clear. Use HTTPS for anything beyond your own LAN.

## Settings

`.env` is the only file you edit, and none of it is needed to start; `.env.example` (in `deploy/compose/`, and
attached to every release as `env.example`) lists every setting with what it is for:

```sh
curl -fsSL -o .env.example https://github.com/escalay/yardhand/releases/latest/download/env.example
```

After changing `.env`: `docker compose up -d`.

| Part | Settings | Without it |
|---|---|---|
| Search by meaning | `OPENROUTER_API_KEY` | tools are found by their words only |
| Smart grouping | `GATEWAY_AI_GROUPING_*`, or Settings › AI in the app | groups come from naming rules |
| Review alerts | `DISCORD_WEBHOOK_URL` | changes wait in the app's Reviews, unannounced |
| Call traces | `GATEWAY_LANGFUSE_URL`, `GATEWAY_LANGFUSE_PUBLIC_KEY`, `GATEWAY_LANGFUSE_SECRET_KEY` | the call log in the app |
| Composio connections | `COMPOSIO_API_KEY` | a personal Composio connection can't list its tools |
| Sign-in by Cloudflare Access | `ACCESS_TEAM`, `ACCESS_AUD` | the owner key |

Settings in the app shows which parts are on.

Usage telemetry is the one part that is on by default: once a day, an anonymous report of ranges and yes/no answers,
the first 24 hours after the first start. `GATEWAY_TELEMETRY=off` (or `DO_NOT_TRACK=1`) in `.env` switches it off, and
`GATEWAY_TELEMETRY_URL` sends it to a collector of your own. Settings › Usage telemetry shows the exact report;
[docs/telemetry.md](../../docs/telemetry.md) lists every field.

## Day to day

| Task | How |
|---|---|
| Update | `curl -fsSLO https://github.com/escalay/yardhand/releases/latest/download/docker-compose.yml && docker compose up -d`. Read the release notes first. The data is backed up before the new version migrates it (Settings › Backups lists it); an older version refuses data a newer one wrote |
| Pin a version | `GATEWAY_IMAGE=ghcr.io/escalay/yardhand:0.1.0` in `.env` (any release tag), then `docker compose up -d` |
| Go back a version | restore the backup kept before the upgrade (Settings › Backups, `before-<version>.sqlite`), then pin the older version |
| Build from source | in a clone: `docker compose -f docker-compose.yml -f compose.build.yml up -d --build` |
| Check an image | With cosign 3 or later: `cosign verify ghcr.io/escalay/yardhand:<version> --certificate-identity-regexp 'https://github.com/escalay/yardhand/' --certificate-oidc-issuer https://token.actions.githubusercontent.com` |
| Logs | `docker compose logs -f gateway` (kept to 30 MB) |
| Status | `docker compose ps`: `healthy` once it answers |
| Stop, start | `docker compose stop`, `docker compose start` |
| A new owner key | `docker compose run --rm -e GATEWAY_SCRIPT=scripts/reset-owner.ts gateway`, `docker compose restart gateway`, then claim it again with the code in the log |

## Backups, restoring and moving

The gateway copies its database once a day and keeps the last seven, in the same volume. In the app, Settings ›
Backups downloads one, makes one now, and restores from one.

| Task | How |
|---|---|
| A copy off the machine | Settings › Backups › Download, or `docker compose cp gateway:/state/backups/. ./backups/` |
| Go back to an earlier day | Settings › Backups › Restore. Today's data is kept as `before-restore-<time>.sqlite` first, and the gateway restarts into the backup |
| Move to another machine | copy `instance.json` from the old volume into the new one (or set the same `GATEWAY_MASTER_KEY`), `docker compose up -d`, then Settings › Backups › Restore from a file with a downloaded backup |
| Restore by hand | `docker compose stop`, copy a backup over `/state/state.sqlite` in the volume, delete `state.sqlite-wal` and `state.sqlite-shm` beside it, `docker compose start` |

A backup holds everything, with stored credentials still sealed. It is only as safe as the place you keep it and
useless without the master key, so keep a copy of `instance.json` (or your `.env`) somewhere else too.

Settings › Export gives connections, agents and tool settings as one JSON file without any secret, for a fresh start
on another gateway where you enter the credentials again.

## What the container may do

The gateway runs with a read-only filesystem apart from its volume and `/tmp`, with every Linux capability dropped and
no way to gain new privileges. It publishes one port, on localhost unless you open it. Its only outbound connections
are to the servers you connect and the optional parts you switch on.

## Remove it

```sh
docker compose --profile https down        # stops it; the data stays in the volume
docker compose --profile https down -v     # and deletes the data, backups included
```

## When something is off

| You see | Why, and what to do |
|---|---|
| `The gateway can't start:` in the logs | a setting is wrong; each line names one and the fix |
| The page asks for a setup code you don't have | it is in `docker compose logs gateway`; a restart prints a new one |
| The container restarts every few seconds | the same: `docker compose logs gateway` |
| The page loads on this machine but not from another | it listens on localhost only: `GATEWAY_BIND=0.0.0.0` in `.env` |
| Connecting an OAuth server sends you to a wrong address | `PUBLIC_HOST` isn't the address you use; set it and `docker compose up -d` |
| A restore is refused: sealed under another master key | this gateway's `GATEWAY_MASTER_KEY` differs from the backup's; use that one, or restore without the stored credentials |
| Caddy never gets a certificate | DNS for `PUBLIC_HOST` doesn't point here yet, or port 80 or 443 is closed |
