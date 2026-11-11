# Yardhand

A self-hosted gateway: one endpoint for every tool its owner connects. Agents connect once over MCP (`/mcp`), scripts
call the same tools over REST (`POST /api/calls`, `GET /api` links to everything), and every upstream's credentials
live once, encrypted, in the gateway. Single owner; it runs anywhere Docker does (`deploy/compose`). The owner's
browser app is at `/app`. Built on agent-api-kit, vendored into `apps/gateway/src/kit` (never edited in place).

How it fits together, with diagrams: `docs/architecture.md`. Releases and what changed: `CHANGELOG.md`.

## Commands

| Command | What |
|---|---|
| `pnpm gate` | biome + typecheck + tests. Run before every commit |
| `pnpm dev` | the gateway on http://localhost:4400 (`/docs`, `/llms.txt`, `/mcp`) |
| `pnpm demo` | a gateway with fake upstreams and the built app (`-- --seed` for data); prints the owner key |
| `pnpm --filter @yardhand/web dev` | the app with hot reload on :5190, API proxied to :4400 |
| `pnpm e2e` | build the app, then Playwright against three demo gateways (first run, in use, a new instance) |
| `pnpm --filter @yardhand/web api-types` | regenerate the app's API types after any route change |
| `pnpm check:fix` | format + safe lint fixes |
| `pnpm --filter gateway env-example` | rewrite `deploy/compose/.env.example` after changing a setting in `src/env.ts` |

Every setting the server reads from its environment is listed once, in `apps/gateway/src/env.ts`: the first-run
`.env`, `.env.example` and the start-up checks come from it, and a test holds `container/entrypoint.sh` to the same
names. A new setting goes there, in the `Env` type and in the entrypoint.

Secrets reach the server only as the environment `container/entrypoint.sh` passes; never print them, and never log a
request that carries one.

The app only calls `/api`: anything it does, an agent can do. A new screen needs its route first (tested in
`apps/gateway/test/app-api.test.ts`), then `api-types`, then the screen and an e2e step if it changes a journey.
Copy is plain and specific; every error says where, why and what to do (the problem `detail`s set the voice).

## Layout

| Path | What |
|---|---|
| `apps/gateway/` | the server (kit app; its own `AGENTS.md` covers the kit shape) |
| `apps/gateway/src/features/<name>/` | anything with tables or routes: upstreams, tools, catalog, calls, clients, search, vault, connections, config |
| `apps/gateway/src/features/instance/` | a new instance's own keys in `instance.json` beside the data (master key, OAuth signing key, the owner's hash), resolved at start before anything opens; never made over a database sealed with other keys. The setup code and the claim live in `features/session` |
| `apps/gateway/src/features/backups/` | download a kept copy of the database; restore from a kept copy or an uploaded file (checked, today's data kept aside, staged, applied at the next start by `applyPending` in `server.ts`) |
| `apps/gateway/src/features/telemetry/` | the daily usage report (`docs/telemetry.md`): `report.ts` builds it, `index.ts` sends it and shows it to the owner (`GET /api/system/telemetry`); switched off only in the environment |
| `apps/gateway/src/features/updates/` | updates (`docs/updates.md`): the daily ask for the newest version (one plain request, no id), the two switches kept in the vault (`GATEWAY_UPDATE_CHECK` and `GATEWAY_AUTO_UPDATE` are only their starting values), and asking for an update: a `request.json` in `<state>/updates` for the updater container, whose `updater.json`, `status.json` and `history.jsonl` it reads, or the platform's deploy hook (`GATEWAY_UPDATE_HOOK`). Routes under `/api/system/updates` |
| `apps/gateway/src/adapters/` | talking to one kind of upstream (`mcp`, `http`, `composio`, `sample`); no tables, no routes |
| `apps/gateway/src/mcp/` | what agents see: meta-tools, pinned tools, playbooks as prompts, manuals as skills, links, passthrough |
| `apps/gateway/src/features/{events,searches,overview,session}/` | what the app stands on: live events (SSE), the search log behind "agents looked for", Home and Settings in one call each, owner sign-in by key where Access isn't in front |
| `apps/web/` | the owner's app at `/app` (Yardhand's look, `src/styles.css`: Inter, graphite and one signal blue, Open Doodles illustrations under CC0): one folder per area (`home`, `connections`, `tools`, `packs`, `agents`, `activity`, `reviews`, `settings`), each with its `*.rules.ts` + tests; `shell/` (the floating sidebar with the six places, reviews and settings, a drawer on phones, the scope picker the filter rows use, ⌘K, live events, sign-in), `setup/` (claiming a new instance and the guided setup at `/app/setup`, outside the sidebar), `ui/` (the shared parts, `Backdrop`, `FilterBar`, `Entity` header + tabs, `LineTabs`, `shadcn/` restyled, illustrations), `api/` (typed client), `e2e/` (Playwright) |
| `deploy/compose/` | the whole product as one compose file with optional Caddy HTTPS and the updater container (`ghcr.io/escalay/updater`, from escalay/selfhost-kit; it holds the Docker socket so the gateway doesn't): the other way to run it (its README) |
| `deploy/release.json` | `upgradeFrom`: the oldest version that can update to the next release in one step. The release workflow adds the version, the image's digest and the compose file's hash and publishes it, signed, as the release's `release.json`: the only thing the updater installs from |
| `deploy/cloud-init.yaml` | the same start on a new server, pasted as user data: installs Docker, starts the latest release in `/opt/yardhand` |
| `packages/client/` | `@yardhand/client`: typed REST client for scripts (`pnpm gen:client` refreshes the tool types) |
| `scripts/` | `smoke-compose.sh`, the self-hosting path end to end against an image, and `smoke-upgrade.sh`, real updates through the updater: the last release with data in it to the image under test, one asked for through the API, one that dies after migrating and must roll back, and the updater switched off (CI runs both) |
| `.github/` | CI (gate, browser tests, the image through the self-hosting path, actionlint and zizmor on the workflows, gitleaks, the pull request title, dependency review), CodeQL, Scorecard, and the release workflow: release-please drafts the release, the image is scanned, smoke-tested, pushed to GHCR and signed, then the release is published |

## Vocabulary

- **Yardhand**: the product. Agents register it as `gw`, so its tools show as `mcp__gw__…`.
- **Claim**: the first owner making a new instance theirs with the setup code from its log (`POST /api/session/claim`).
- **Sample tools**: an upstream of kind `sample` with three harmless built-in tools, for trying every step of the setup.
- **Upstream**: a server the gateway reaches (an MCP server, a REST API, Composio, or the built-in sample tools).
- **Composio upstream** (`kind: composio`, `adapters/composio.ts`): the real tools of chosen toolkits, named after
  their slugs (`composio.gmail_fetch_emails`), each with an `account` input; `GET /api/upstreams/{id}/accounts` lists
  the accounts by label. `personal` mode: a personal key (`x-consumer-api-key`) through Composio's hosted MCP, the tool
  list read with `COMPOSIO_API_KEY` (a CLI user key, env). `project` mode: a project key (`x-api-key`) and `userId`
  through the REST API.
- **Adapter**: the code for one kind of upstream; turns it into tools.
- **Tool**: `<upstream>.<tool>`, e.g. `cookbook.research_recipes`. A tool has versions; only a `live` version is served.
- **Client**: who calls the gateway (an API key or an OAuth client): an allowlist of upstreams, read/write scope, pins.
- **Pin**: a real tool shown directly in a client's MCP tool list beside the meta-tools.
- **Access**: the owner's per-tool setting (`PATCH /api/tools/{name}`): `read` or `write` override the upstream's
  hints; `off` hides the tool from every client but the owner and the pipeline and passthrough refuse it for everyone.
- **Group**: a part of a connection's tools (`features/groups`, tables in `features/tools`), found by rules
  (`tools/groups.ts`), a model, or the owner. Off switches off its tools now and later, unless a tool has its own
  access. A Composio connection's groups are its apps; an app off isn't fetched (`composio.off`).
- **Effect switch**: a connection's reads, changes or deletes switched off at once (`effectOf` in `tools/groups.ts`:
  hints, then the name and route; a tool the owner set is outside the switches). A tool's `offBy` says why it is off:
  `you`, `group` or `effect`.
- **AI job** (`features/ai`): search by meaning (embeddings; only its key is settable, the model is the kit's) and
  smart grouping (a writer names groups over any OpenAI-compatible API; a decider files tools via TypeSafe's System
  One, e.g. `typesafe/jev-1.14`, or a chat model). `.env` seeds (`GATEWAY_AI_GROUPING_*`, `OPENROUTER_API_KEY`),
  Settings › AI wins (sealed in the vault as `ai:<job>`); keys never leave.
- **Call**: one execution through the pipeline; its record, held result pages and encrypted payload. A call's `kind`
  is `tool`, or a read: `manual`, `playbook`, `link`.
- **Catalog**: what an upstream offers besides tools, versioned and reviewed like tools (`features/catalog`).
- **Manual**: an upstream's skill (Skills extension), every file; served with the gateway's note on top, as a skill,
  as `gateway://u/<upstream>/manual`, and at `GET /api/manuals/{name}`.
- **Playbook**: an upstream's prompt, named `<upstream>-<prompt>`; listed as an MCP prompt, suggested by search.
- **Link**: a resource an upstream serves (`cookbook://recipes/123`), read as it comes with `read_resource`.
- **Pack**: a curated kit for one kind of work (`features/packs`): tools from any upstreams, each with an optional
  pack wording, alias and fixed inputs, plus playbooks and manuals. Starting from a playbook brings in the tools it names or calls by route
  (a server publishes a tool's route in `_meta` under a `<vendor>/route` key, the kit as `agent-api-kit/route`; stored on the tool row, never versioned).
- **Pack key**: a key locked to one or more packs, optionally expiring (8 h, 1 day, 7 days). Each pack is its own
  connection at `/mcp/p/<pack>` (rewritten to `/mcp` up front, the choice carried in `features/clients/pack-choice.ts`);
  plain `/mcp` and REST serve its default pack, and REST names another with `x-gateway-pack`. A request sees and runs
  only its one pack.
- **Alias**: a pack's own name for one of its tools (`team_inbox_search`); the same tool can be in a pack under
  several aliases. A pack tool is keyed by that name; `entryOf` resolves it to the tool.
- **Fixed input**: an input a pack tool fills on every call, hidden from the pack's keys; a call that sends it is a
  400 (`features/packs/entries.ts`).
- **Flag**: pack wording written against a tool version whose description has since changed, or a fixed input the
  live tool no longer takes; agents keep the wording, the owner keeps or rewrites it (pack page, Reviews, Home nudge).
- **Asked**: a call whose upstream asked something mid-call (MCP input requests); the answers come as the next call
  with the sealed `requestState`.

## Invariants

1. Every call, MCP or REST, goes through the one pipeline: authenticate → allowlist → scope → resolve → credential →
   adapter → cap → audit. No route calls an adapter directly.
2. Secrets are AES-GCM encrypted in SQLite with the master key from env (`GATEWAY_MASTER_KEY`); they never appear in
   logs, exports, call payloads sent to Langfuse, or errors.
3. Third-party upstreams (`trust = review`) never change a live tool by themselves: a changed description or schema is
   a `pending` version until the owner approves it.
4. `src/kit/` is vendored from agent-api-kit. Its behaviour is never edited in place; its examples, comments and the
   route key (`agent-api-kit/route`) are this repo's own, so an update is reviewed line by line, never copied over whole.
5. Tool names use only letters, digits, `_`, `-`, `.`.
6. Access is per upstream, then per tool: the link proxy `GET /u/{id}/r/*` lets any client allowed on an upstream
   read any path on that upstream's own origin with the gateway's credential (reads only, never other hosts).
   Tool-level access (write scope, review) applies to tool calls, not to these links. The owner switches it off per
   upstream (`linkProxy: false`) for an account-wide API such as Composio: then links stay as they are and the proxy
   refuses. A pack key is the exception: it opens only the links its tools' results handed it in the last day
   (`features/calls/handed.ts`), through the proxy and `read_resource` alike.
7. Reads (a manual, a playbook, a link) go through the same rules as calls (`features/calls/reads.ts`) and land in
   the same log; manuals and playbooks reach agents only as an approved (`live`) version.
8. The pack lock lives on the principal (`features/clients/principals.ts`): a pack key's upstreams are the pack's,
   and `reaches` / `runsTool` / `holds` / `shownAs` keep tools, playbooks, manuals, names, wording and fixed inputs to
   the pack at every site that lists or runs anything; `seenBy` is the one rule for which tools a caller is listed.
   A pack key never gets a passthrough. A new place that lists or runs tools uses them.
   The passthrough (`/u/{id}/mcp`) exists only for `trusted` upstreams (a `review` upstream's lists would reach agents
   unapproved) and runs only tools the gateway serves live.
9. Upstream failures leave as 503 problems (code `upstream`, `Retry-After: 30`), never 502: a proxy in front may
   replace a 502 body with its own page.
10. One sync of an upstream runs at a time (`services.sync`), and an MCP or REST upstream that lists no tools where it
    had some is marked failing and keeps them.
11. Nothing but the owner switches a tool on: a regroup, a deleted group, a new tool in an off group and a change to
    how effects are counted all leave an off tool off.
12. The database is never swapped under a running server: a restore stages a file and the process restarts; `server.ts`
    puts it in place before anything opens it, removing the old write-ahead log.
13. Releases come only from the release workflow: a version is never set by hand (release-please writes it into
    `version.ts`, the packages and the compose file), every published image is scanned, signed and attested, and a
    release is published only after its image is. Dependencies are at least a week old (`minimumReleaseAge`,
    Dependabot's cooldown).
14. The usage report carries ranges and yes/no answers only, never anything an owner named or a call carried. A new
    field is a new schema number, in `ReportSchema`, the app's labels and `docs/telemetry.md`, and accepted by the
    collector before the release that sends it. It is switched off only in the environment, never in the app, and
    tests, the demo and the smoke test never send.
15. The gateway never updates itself and never reaches Docker: asked to update, it writes a request beside its data
    and an updater outside carries it out. The version it asks for is a hint the updater verifies against the signed
    release; the newest version it is told is only ever a version number, and the release-notes link is built here.
    Tests, the demo and the smoke test never ask for a newer version, and the deploy hook's address and token are
    never logged or returned.
