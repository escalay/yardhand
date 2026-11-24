# Yardhand

A self-hosted gateway: one endpoint for every tool its owner connects. Agents connect once over MCP (`/mcp`), scripts
call the same tools over REST (`POST /api/calls`, `GET /api` links to everything), and every upstream's credentials
live once, encrypted, in the gateway. Single owner; it runs anywhere Docker does (`deploy/compose`). The owner's
browser app is at `/app`. Built on api-kit, vendored into `apps/gateway/src/kit` (never edited in place).

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
| `apps/gateway/src/features/packs/` | packs. What a pack sets on its tools' inputs is read in three files: `values.ts` (variables, `{{name}}` filled in), `state.ts` (a pack as its checks read it, and the state a change would leave), `checks.ts` (`checkPack`, the one check function, and `judge`, the one rule for a change: refused only for what it breaks itself). Every way of writing a pack goes through them: the handlers and the config import. What is written for a pack is Markdown: `playbook.ts` and `skill.ts` read the two kinds of text, `frontmatter.ts` the YAML block at a playbook's top, and `own.routes.ts` with `own.handlers.ts` are the authoring routes; the same checks read them, and `flags.ts` says when a tool moved under one. `own.ts` (`packDocs`) is the one way they are read for a caller: what its pack lock names, and nothing else |
| `apps/gateway/src/features/builds/` | Build and Refresh with AI (`pack_builds`): `builder.ts` runs one build per pack at a time in the process (kit → a playbook a task → skill → checks and one repair → a rehearsal a task), `drafts.ts` the asks and how each answer is read, `rehearsal.ts` what runs (`rehearses`) and as whom (`rehearsalPrincipal`), `spend.ts` the $1 cap and the estimate, `proposal.ts` the lines, what each needs, and how chosen ones are applied (`applyLines`, judged by the pack's own `judge`) and written |
| `apps/gateway/src/features/instance/` | a new instance's own keys in `instance.json` beside the data (master key, OAuth signing key, the owner's hash), resolved at start before anything opens; never made over a database sealed with other keys. The setup code and the claim live in `features/session`. `upgrade.ts` there copies the data before a newer version migrates it, refuses data a newer version wrote, and undoes an update that never came up: when this version starts and finds the copy a newer one made without ever recording itself, that copy becomes the data (what was left is kept as `backups/failed-<version>.sqlite`) |
| `apps/gateway/src/features/backups/` | download a kept copy of the database; restore from a kept copy or an uploaded file (checked, today's data kept aside, staged, applied at the next start by `applyPending` in `server.ts`) |
| `apps/gateway/src/features/telemetry/` | the daily usage report (`docs/telemetry.md`): `report.ts` builds it, `index.ts` sends it and shows it to the owner (`GET /api/system/telemetry`); switched off only in the environment |
| `apps/gateway/src/features/updates/` | updates (`docs/updates.md`): the daily ask for the newest version (one plain request, no id), the two switches kept in the vault (`GATEWAY_UPDATE_CHECK` and `GATEWAY_AUTO_UPDATE` are only their starting values), and asking for an update: a `request.json` in `<state>/updates` for the updater container, whose `updater.json`, `status.json` and `history.jsonl` it reads, or the platform's deploy hook (`GATEWAY_UPDATE_HOOK`). Routes under `/api/system/updates` |
| `apps/gateway/src/adapters/` | talking to one kind of upstream (`mcp`, `http`, `composio`, `sample`); no tables, no routes |
| `apps/gateway/src/mcp/` | what agents see: meta-tools, pinned tools, playbooks as prompts, manuals and a pack's own skill as skills, links, passthrough |
| `apps/gateway/src/features/{events,searches,overview,session}/` | what the app stands on: live events (SSE), the search log behind "agents looked for", Home and Settings in one call each, owner sign-in by key where Access isn't in front (that session also approves an app's OAuth sign-in, at `/oauth/authorize` only, never a claim), and until 0.7.0 the `sign-in` log of what each app sends (`session/sign-ins.ts`) |
| `apps/web/` | the owner's app at `/app` (Yardhand's look, `src/styles.css`: Inter, graphite and one signal blue, Open Doodles illustrations under CC0): one folder per area (`home`, `connections`, `tools`, `packs`, `agents`, `activity`, `reviews`, `settings`), each with its `*.rules.ts` + tests; `shell/` (the floating sidebar with the six places, reviews and settings, a drawer on phones, the scope picker the filter rows use, ⌘K, live events, sign-in), `setup/` (claiming a new instance and the guided setup at `/app/setup`, outside the sidebar), `ui/` (the shared parts, `Backdrop`, `FilterBar`, `Entity` header + tabs, `LineTabs`, `shadcn/` restyled, illustrations), `api/` (typed client), `e2e/` (Playwright) |
| `deploy/compose/` | the whole product as one compose file with optional Caddy HTTPS and the updater container (`ghcr.io/escalay/updater`, from escalay/selfhost-kit; it holds the Docker socket so the gateway doesn't): the other way to run it (its README) |
| `deploy/release.json` | `upgradeFrom`: the oldest version that can update to the next release in one step. The release workflow adds the version, the image's digest and the compose file's hash and publishes it, signed, as the release's `release.json`: the only thing the updater installs from |
| `deploy/helm/yardhand/` | the Helm chart (its README beside it): one pod as a non-root user with a read-only filesystem, one volume that outlives the release, `GATEWAY_INSTALL=helm`. Released with the app under the same number to `oci://ghcr.io/escalay/charts/yardhand`. No updater there: updates are `helm upgrade`, and a failed one is undone by `helm rollback` plus the start-up rule in `features/instance/upgrade.ts` |
| `deploy/cloud-init.yaml` | the same start on a new server, pasted as user data: installs Docker, starts the latest release in `/opt/yardhand` |
| `packages/client/` | `@yardhand/client`: typed REST client for scripts (`pnpm gen:client` refreshes the tool types) |
| `scripts/` | `smoke-compose.sh`, the self-hosting path end to end against an image, and `smoke-upgrade.sh`, real updates through the updater with Caddy in front: every release from `upgradeFrom` up, with data in it, to the image under test, one asked for through the API, one that dies after migrating and must roll back, and the updater switched off (CI runs both); and `smoke-helm.sh`, the chart on a cluster: the last release installed, upgraded to the image under test, a version that dies after migrating, and `helm rollback` (CI runs it on kind) |
| `.github/` | CI, which tests a change by what it could break: `scripts/ci-plan.sh` decides which slow jobs a run needs (its cases are `scripts/ci-plan.test.sh`; a new top-level folder or a file it doesn't know runs everything), a push to main repeats nothing its pull request passed on the same commit, a release's pull request gets one real update, and every night everything runs from every release. The jobs (gate, browser tests, the image through the self-hosting path, actionlint and zizmor on the workflows, gitleaks, the pull request title, dependency review), CodeQL, Scorecard, and the release workflow: release-please drafts the release, the image is scanned, smoke-tested, pushed to GHCR and signed, then the release is published |

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
  An OAuth client is made with its sign-in (the kit's `onGrant`, `features/clients/grants.ts`) and known by the kit's
  grants (`client_grants`), never by the name its app gives: a token whose grant has no row is a 401 pointing where
  the kit's own would (`resourceMetadata` on the caller), its grant is ended at the kit, and nothing makes one on
  use. Sign-ins from before 0.6.4 were mapped once by that name (`legacy.ts`, recorded in the plain
  `client_legacy_mapping`, never the vault, so a start under another master key still comes up); an access token
  from then, which carries no grant, still finds its row by name for its last hour. Revoking one ends each of its
  grants at the kit (`revokeGrant`, never `revokeClient`).
- **Pin**: a real tool shown directly in a client's MCP tool list beside the meta-tools: the client's own pins, else
  the global ones. Inside a pack a pin is the pack's name for the tool (its alias, else the tool's own name), a key's
  own pins narrow its list from the whole pack to those, and the global pins never apply (`pinnedBy`).
- **Access**: the owner's per-tool setting (`PATCH /api/tools/{name}`): `read` or `write` override the upstream's
  hints; `off` hides the tool from every client but the owner and the pipeline and passthrough refuse it for everyone.
- **Group**: a part of a connection's tools (`features/groups`, tables in `features/tools`), found by rules
  (`tools/groups.ts`), a model, or the owner. Off switches off its tools now and later, unless a tool has its own
  access. A Composio connection's groups are its apps; an app off isn't fetched (`composio.off`).
- **Effect switch**: a connection's reads, changes or deletes switched off at once (`effectOf` in `tools/groups.ts`:
  hints, then the name and route; a tool the owner set is outside the switches). A tool's `offBy` says why it is off:
  `you`, `group` or `effect`.
- **AI job** (`features/ai`): search by meaning (embeddings; only its key is settable, the model is the kit's),
  smart grouping (a writer names groups over any OpenAI-compatible API; a decider files tools via TypeSafe's System
  One, e.g. `typesafe/jev-1.14`, or a chat model) and Build with AI (`builds`: one chat model that drafts packs; its
  provider, address and key are one connection, its own once it sets any of them, else grouping's whole, and its
  model left unset is grouping's writer, each shown as `from: grouping`). `.env` seeds (`GATEWAY_AI_GROUPING_*`,
  `GATEWAY_AI_BUILDS_*`, `OPENROUTER_API_KEY`), Settings › AI wins (sealed in the vault as `ai:<job>`); keys never leave.
- **Call**: one execution through the pipeline; its record, held result pages and encrypted payload. A call's `kind`
  is `tool`, or a read: `manual`, `playbook`, `link`. Its `via` is the door it came by: `rest`, `mcp`, `passthrough`,
  `app`, or `rehearsal` (a build trying a task: listed, never counted as use; no caller can claim it).
- **Catalog**: what an upstream offers besides tools, versioned and reviewed like tools (`features/catalog`).
- **Manual**: an upstream's skill (Skills extension), every file; served with the gateway's note on top, as a skill,
  as `gateway://u/<upstream>/manual`, and at `GET /api/manuals/{name}`.
- **Playbook**: an upstream's prompt, named `<upstream>-<prompt>`; listed as an MCP prompt, suggested by search.
- **Link**: a resource an upstream serves (`cookbook://recipes/123`), read as it comes with `read_resource`.
- **Pack**: a curated kit for one kind of work (`features/packs`): tools from any upstreams, each with an optional
  pack wording, alias, fixed inputs and defaults, the pack's variables, plus playbooks and manuals from its
  connections, and the playbooks and one skill written for it. Starting from a playbook brings in the tools it names or calls by route
  (a server publishes a tool's route in `_meta` under a `<vendor>/route` key, the kit as `api-kit/route`; stored on the tool row, never versioned).
- **Pack key**: a key locked to one or more packs, optionally expiring (8 h, 1 day, 7 days, 30 days). Each pack is its own
  server at `/p/<pack>/`: MCP at `/p/<pack>/mcp` and REST under `/p/<pack>/api` (rewritten to `/mcp` and `/api` up
  front, the choice carried in `features/clients/pack-choice.ts`), with its own guide, OpenAPI document and docs page
  beside them (`features/packs/docs.ts`). `/mcp/p/<pack>` and the `x-gateway-pack` header (on REST and on `/mcp`)
  still work, and each also takes a name the pack used to have (**Old name**); plain `/mcp` and REST serve the key's
  default pack. A request sees and runs only its one pack. A pack connection has the gateway's shape under the pack's
  name: the meta-tools over the pack, and every tool of the pack listed directly, or only the key's own pins. The
  owner asking for a pack (its address or the header) is answered as a write key of that pack and refused the routes
  that manage the gateway (`requireOwner`).
- **Old name**: a name a pack had when it was renamed (`PATCH /api/packs/{name}` with `name`) while it had a key that
  was not revoked, kept in `pack_names`. It is read as the name the pack has now in `packChoice`, after
  authentication, at `/p/<old>/`, `/mcp/p/<old>` and `x-gateway-pack`: MCP and REST are served in place, the pack's
  own pages answer 308 to the new address. A key that does not open the pack is refused by the name it asked for
  (`packFor`), so an old name tells it nothing of the name now; only the owner is told where a pack went (`noPack`).
  No pack can take an old name until the owner frees it (`DELETE /api/packs/{name}/names/{former}`) or removes the
  pack. Each key's link to the pack notes the old name it was last let in by (`client_packs.came_by`), which a pack's
  `formerNames` count over the people it lists (`listedOf`), ended ones too.
- **Extend**: sets a key's end anew, counted from today (`PATCH /api/clients/{id}` with `expiresIn`: 7 days, 30 days
  or never), also for a key that has ended: it works again with the same key. A revoked key does not come back, and
  a pack key none of whose packs is left is refused (409) unless the same change gives it one.
  The kit keeps no refusal for an `Idempotency-Key`: a request refused while the key had ended runs once it is sent
  again, with the same key or a new one.
- **Ended**: a key past its end. Every route a pack serves (`PACK_PATHS` and the pack's pages) refuses it with a 403
  that names its pack, the day and whom to ask (`refusalOf`), but for a request repeated with an `Idempotency-Key`
  it sent while it worked: the kit answers that with what the key was already given, before any route, and nothing
  runs. Owner-only routes refuse it as any client key, and the gateway's own `/llms.txt`, `/openapi.json` and `/docs`
  still answer it. Over MCP it still connects, to read the refusal as the instructions and from every tool
  (`principals.ended` at the `/mcp` door): safe only while every route resolves its caller through `principals` or
  `requireOwner`. The owner looking as an ended client reads `endedNote` instead.
- **Person**: a client that opens a pack, as its People list has it (`GET /api/packs/{name}/people`); the
  `client_packs` row is that person in that pack. `standingOf` (`features/clients/lifetimes.ts`) is the one rule for
  where their access stands: `ending` in its last three days, `ended` and still listed for 30 days after its end,
  then gone, as a revoked key is at once. A pack's `keys + ended` is the number People lists (`listedOf`).
  `endingAccess` (`features/clients/ending.ts`) is everyone `ending`, each by their default pack (else the first
  pack they still open): Home's `access_ending` nudge and the hourly webhook notice (`accessNotifier` in `jobs.ts`,
  once per end) both read it.
- **Share**: making one person's key for one pack (`POST /api/packs/{name}/people`): read only and 30 days unless
  said, answered with a message ready to send (`features/packs/share.ts`), the key in it and shown once. Every key
  client is made by `principals.issue`.
- **Alias**: a pack's own name for one of its tools (`team_inbox_search`); the same tool can be in a pack under
  several aliases. A pack tool is keyed by that name; `entryOf` resolves it to the tool. A new alias can't be a name
  a connection's own tools hold (`OWN_NAMES`: the meta-tools and `call_tool`); one stored before that rule keeps
  working, run through `call_tool`.
- **Input mode**: who fills one input of a pack tool (`features/packs/entries.ts`). **Fixed**: the pack, on every
  call, hidden from its keys; a call that sends it is a 400. **Default**: shown to its keys with the pack's value as
  the schema's `default` and filled when a call leaves it out; the caller's own value wins. **Per person**: hidden
  like Fixed, and filled with one variable as it is for the caller: their own value (`pack_person_values`, set by the
  owner under People and in Share), else the pack's, else nothing is sent and the tool's own default applies; a
  required input with no value at all and no default is a 409 naming the variable, never the input. A person's value
  fills Per person inputs only and goes with its variable, and a lock built for no person (`packScopeFrom` without
  their values: the owner inside a pack) reads the pack's.
  **Agent decides**: the input as the tool has it. Stored per pack tool as `fixed`, `defaults` and `person`; an input
  in none is the agent's.
- **Variable**: a named value of a pack (`PUT /api/packs/{name}/variables`), written `{{name}}` in a fixed or default
  value and filled in when the pack lock is built (`packScopeFrom`). A value that is one variable and nothing else
  takes its type. Only a name the pack declares is a variable: any other `{{word}}` is sent as written.
- **Pack playbook**: a playbook written for one pack (`POST /api/packs/{name}/playbooks`), Markdown whose front
  matter gives its title, description and arguments. Its text writes an argument or a variable as `{{name}}` and
  names the pack's tools in backticks, by the names the pack calls them: only a backticked name is read as a tool.
  Kept in the gateway with every version it had (`pack_docs`, `pack_doc_versions`), never in the catalog, and only
  ever read by its pack's id. Its pack's keys get it wherever they get a playbook, first and under the name the pack
  gave it: `GET /api/playbooks` (`upstream: null`, `pack` set; left out with `?upstream=`), as an MCP prompt, through
  `get_playbook`, in search hints and in the pack's guide. Filled in by the gateway: the arguments given, then the
  pack's variables. Every `{{word}}` in a playbook's text or the skill is read and filled in, inside fenced code
  blocks too, and there is no escape to keep one as written. A playbook's front matter (title, description, an
  argument's description) is not read for them: it is served as written. It belongs to no connection, so none
  counts it and its reads are logged with no upstream.
- **Pack skill**: the one `SKILL.md` of a pack (`PUT /api/packs/{name}/skill`), "Working with <Title>", in six
  sections. The pack stores the text only; the front matter and the heading are written from the pack
  (`skillFile`), at `skill://<pack>/SKILL.md` (`packSkillPathOf`), by the name the pack has now. Its keys read it
  there (`read_resource`, `GET /api/resources`, the Skills extension, each logged as a `manual` read), the pack's
  instructions send them to it first, and it opens the pack's guide (`/p/<pack>/llms.txt`). It wins its address: a
  manual the pack holds that would sit there too is left out of the Skills list and read as a manual
  (`gateway://u/<upstream>/manual`).
- **Finding**: what `checkPack` says about a pack as it stands (`findings` on `GET /api/packs/{name}`): an error (an
  input the tool doesn't take, a value its schema refuses once the variables are filled in) or a warning (a
  `{{word}}` that is no variable, an unused variable, a value not checked because its input's schema can't be read).
  In a pack playbook or the skill: an error for a tool that is not in the pack, or named by its own name where the
  pack gives it another, for a name the text was written for that has left the pack, for a `{{word}}` that is
  neither an argument nor a variable (in a text nothing is sent as written), and for an argument named like what
  every object has (`constructor`); a warning for a tool a read-only key can't run, a name shaped like a tool that is
  none (a file's name is not one), a `{{…}}` that is no name, more than 12 steps, a missing skill section, a
  playbook the skill names that the pack lacks (`unknown_playbook`). A document's errors refuse a save only when
  that document is the one saved (`judge`).
- **Flag**: pack wording written against a tool version whose description has since changed, or a fixed or default
  value the live tool no longer takes (its input is gone, or no longer takes the value), shown on the pack page, in
  Reviews and as a Home nudge. Agents keep the wording. Until the owner changes the value, a fixed one the tool
  refuses fails every call, a default it refuses fails the calls that leave the input out, and a value for a dropped
  input is still sent (it fails only where the server refuses inputs it doesn't know). A pack playbook or the skill
  is flagged when a tool it was written against (`based_on`, by the pack's names) reads differently now, is not
  live, or is no longer in the pack under that name: renaming, removing or losing a tool never fails on a text.
  Saving the text again clears it, and is refused while the text still names a tool the pack no longer has. A flag
  never blocks a change that leaves it alone.
- **Build**: Build or Refresh with AI of one pack (`POST /api/packs/{name}/builds`, 202, polled): a model drafts its
  tools, wording, variables, input modes, playbooks and skill from its purpose and one to five example tasks, then
  rehearses each, and keeps one sealed **proposal**: lines (`tool:`, `wording:`, `input:`, `variable:`,
  `playbook:`, `skill`), each with before, after and the lines it `needs`. A tool that changes things is unticked
  unless asked with `includeChanges`, a tool taken out always is, and a tool leaves only when it is not live or is
  off. A playbook is named for its task and never onto one the pack holds, unless the model says it `revises` one of
  the pack's own; the skill's Playbooks list is written from the draft, and again from the pack at accept. Accepted
  once, line by line, onto the pack as it was when the build started, through `judge`. `$1` at most on the model (`BUILD_CAP_USD`), checked before
  every ask; an estimate over it is a 429 `spend_cap`. One running per pack, six an hour per pack and caller.
- **Rehearsal**: a build trying one example task with the drafted pack: the model picks a tool a step (6 at most);
  one that `rehearses` (its hints say it reads, the owner's setting agrees, not off, its route a read) runs through
  the pipeline as a read-only owner locked to the draft by `packScopeFrom`, with the pack's own values and no
  person's (`rehearsalPrincipal`); any other gets a stand-in saying nothing happened, never reaches the pipeline, and
  leaves its task not `tried`, as a refused or failed step does. Results go to the model
  only. No person's name or value reaches a build: Refresh reads the pack's flags with no one's values, and a build
  never proposes a Per person input nor changes one.
- **Asked**: a call whose upstream asked something mid-call (MCP input requests); the answers come as the next call
  with the sealed `requestState`.

## Invariants

1. Every call, MCP or REST, goes through the one pipeline: authenticate → allowlist → scope → resolve → credential →
   adapter → cap → audit. No route calls an adapter directly.
2. Secrets are AES-GCM encrypted in SQLite with the master key from env (`GATEWAY_MASTER_KEY`); they never appear in
   logs, exports, call payloads sent to Langfuse, or errors. An answer the kit keeps for an `Idempotency-Key` can
   hold a key shown once, so the store it is given seals every answer (`features/vault/answers.ts`).
3. Third-party upstreams (`trust = review`) never change a live tool by themselves: a changed description or schema is
   a `pending` version until the owner approves it.
4. `src/kit/` is vendored from api-kit and never edited, examples and comments included: a change goes upstream, then
   `kit update`. An update is still reviewed part by part against the kit's CHANGELOG.
5. Tool names use only letters, digits, `_`, `-`, `.`.
6. Access is per upstream, then per tool: the link proxy `GET /u/{id}/r/*` lets any client allowed on an upstream
   read any path on that upstream's own origin with the gateway's credential (reads only, never other hosts).
   Tool-level access (write scope, review) applies to tool calls, not to these links. The owner switches it off per
   upstream (`linkProxy: false`) for an account-wide API such as Composio: then links stay as they are and the proxy
   refuses. A pack key is the exception: it opens only the links its tools' results handed it in the last day
   (`features/calls/handed.ts`), through the proxy and `read_resource` alike.
7. Reads (a manual, a playbook, a link) go through the same rules as calls (`features/calls/reads.ts`) and land in
   the same log; manuals and playbooks reach agents only as an approved (`live`) version. A pack's own playbooks and
   skill are the owner's words: they are read there too, and served as their newest saved text.
8. The pack lock lives on the principal (`features/clients/principals.ts`): a pack key's upstreams are the pack's,
   and `reaches` / `runsTool` / `holds` / `holdsOwn` / `shownAs` keep tools, playbooks, manuals, names, wording, fixed
   inputs and defaults, and the playbooks and skill written for the pack, to the pack at every site that lists or
   runs anything (`packScopeFrom` is the only place the lock is built). A pack's own playbooks and skill are read
   for a caller only through `packDocs` (`features/packs/own.ts`), by the pack on the principal: the lock first,
   then the pack. `seenBy` is the one rule for which tools a caller is listed,
   and `pinnedBy` for which of them MCP lists directly. Search scores every tool and then keeps to `seenBy`, and a
   pack key's connection cards count only what the pack holds. A pack key never gets a passthrough. The owner asking
   for a pack is such a principal too (`owner: false`), held to the same rules. A new place that lists or runs tools
   uses them. `withPackAddresses` (`features/clients/pack-choice.ts`) keeps the `_links` of an answer inside a pack's
   address when the request came by it, outside the app, so a replayed answer is linked for the address asking.
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
    What an owner must know before updating (a new default, a step by hand) is written in
    `docs/releases/<version>.md` before the release pull request merges; the workflow puts it at the top of the notes.
14. The usage report carries ranges and yes/no answers only, never anything an owner named or a call carried. A new
    field is a new schema number, in `ReportSchema`, the app's labels and `docs/telemetry.md`, and accepted by the
    collector before the release that sends it. It is switched off only in the environment, never in the app, and
    tests, the demo and the smoke test never send.
15. The gateway never updates itself and never reaches Docker: asked to update, it writes a request beside its data
    and an updater outside carries it out. The version it asks for is a hint the updater verifies against the signed
    release; the newest version it is told is only ever a version number, and the release-notes link is built here.
    Tests, the demo and the smoke test never ask for a newer version, and the deploy hook's address and token are
    never logged or returned.
16. A rehearsal never runs a tool that changes things: `rehearses` decides before the pipeline is called, and the
    rehearsal's principal is read-only so the pipeline refuses one too. A build saves nothing to a pack until the
    owner accepts lines, spends at most `BUILD_CAP_USD` on the model, and keeps its proposal sealed. Tests and the
    demo build with a scripted model (`test/fixtures/model.ts`), never a provider.
