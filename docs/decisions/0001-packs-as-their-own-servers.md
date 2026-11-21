# 0001 · A pack is a small Yardhand of its own

Status: accepted · 2026-11-21 · Built in four pull requests (see [Rollout](#rollout)).

## Context

A pack is a curated kit for one kind of work: tools from any connection, in its own wording, with playbooks and
manuals. Pack keys open only their packs, at `/mcp/p/<pack>` or with the `x-gateway-pack` header. That much holds, but
using a pack key day to day showed where it stops feeling like a server of its own:

- **Search returns noise.** Search by meaning ranks every tool with no floor (`nearest()`), keeps the top 100 of the
  caller's *connections*, then fuses with keyword hits by rank. On a full catalog real matches bury the noise; in a
  20-tool pack the noise is all there is. A nonsense query returns seven tools, and a pack tool that ranks below 100
  inside a 1,000-tool connection is lost even when it is the right one.
- **Counts leak the catalog.** `list_upstreams` and `GET /api/upstreams` give a pack key a connection's full tool,
  playbook and manual counts (1,036 tools where the pack holds ten).
- **It is still called Yardhand**, its docs (`/llms.txt`, `/docs`) describe the whole gateway, and MCP, REST and docs
  live at three unrelated addresses.
- **Only key-based apps can use it.** claude.ai and ChatGPT add servers through OAuth, and a pack has no sign-in that
  someone other than the owner can pass.
- **Writing a good pack is all manual.** Its playbooks and manuals can only be ones an upstream wrote, inputs are
  either fixed or left to the agent, and nothing checks a pack works before an agent uses it.

## Decision

**A pack is a small Yardhand of its own: one address, its own tools, its own people.** It is the gateway exactly
(MCP with search, REST, docs), seeing only the pack.

### 1. The pack as its own server

- **One address.** Everything under `/p/<pack>/`: `/p/<pack>/mcp`, `/p/<pack>/api/…`, `/p/<pack>/llms.txt`,
  `/p/<pack>/docs`. `/mcp/p/<pack>` and `x-gateway-pack` keep working.
- **The same shape as the gateway.** The meta-tools (`search_tools`, `describe_tool`, `call_tool`, `get_result`,
  `list_upstreams`, `read_resource`, `get_playbook`) over the pack's tools only, and only pinned tools listed directly.
  The server name and instructions are the pack's; its `llms.txt` and docs describe the pack and its tools.
- **Its own counts.** A pack key's `list_upstreams` and `GET /api/upstreams` show only the pack's connections, with
  the pack's tool, playbook and manual counts.
- **Search that can say "nothing".** Search by meaning uses the kit's `standouts()`: every tool is scored, so the
  spread is the whole catalog's, and `keep` then limits it to the tools this caller is listed (`seenBy`), not to their
  connections. Never compute the bar over the pack alone: 20 rows can't reach z 3.5. `names()` stays as it is for smart
  inclusion, which wants an answer every time. The bar (`minZ`, `minScore`) is chosen by replaying logged searches
  (the search log behind "agents looked for") before release, since it changes every key's search.
- **An empty search helps.** `count: 0` and, for a pack, "Nothing in Career matches 'logos'. This pack covers: job
  search, inbox, talks." (from the groups of the pack's tools), not "try list_upstreams".
- **Building is checked as you go.** The pack page's Overview carries a four-step checklist (describe it, add tools,
  try it, connect), a **Try it** panel that searches exactly as a pack key does, and an **Address** card with setup
  per app. The owner at a pack address is offered "See it as Sam would" instead of a refusal.

### 2. Sharing with key-based apps

- **Keys become People.** One row per person: how they connect, access, when it ends, last call, calls in 7 days;
  Extend, Revoke, and their Activity.
- **Share.** Who, which app, what they can do (asked only when the pack holds tools that change things; read by
  default), and how long: 7 days, **30 days** (default) or until revoked. It ends on a message ready to send, the key
  shown once.
- **Endings are plain.** A nudge three days before access ends, with Extend. An ended key's refusal names the pack,
  the date and what to do ("ask the owner for a new invite"), never a bare 403.
- **Renaming keeps addresses.** A shared pack's old name keeps leading to the new one; People notes who still uses it.
- Sharing a pack that acts on the owner's accounts asks nothing extra: the owner decides what goes into a pack.

### 3. claude.ai and ChatGPT

- **Invite links.** `/p/<pack>/join/<code>`: the pack's title and purpose, who invited whom, and steps per app. The
  page remembers the invite in that browser, so the sign-in that follows is one Approve; on another device the sign-in
  takes the code. One use, redeemed within 24 hours.
- **A public sign-in page, guarded by the gateway.** `/p/<pack>/oauth/…` is reachable without the owner's front door
  (Cloudflare Access or similar) and signs someone in only with a valid invite or the owner's live approval,
  rate-limited. `/app` and the owner's own sign-in are unchanged.
- **Ask to join.** Off until the owner switches it on for a pack. The person gets a 6-digit code; the owner gets a
  toast, a "waiting" pill and Approve or Refuse on People; the request lapses after 10 minutes.
- **What a stranger sees.** A pack's address without an invite or key shows its title and "This pack is invite-only"
  (and Ask to join when on). The purpose and tools only with an invite or key.
- A signed-in client opens only that pack, for the lifetime chosen on its invite.

### 4. Authoring a pack

- **Variables.** Named per pack and used as `{{name}}` in tool inputs, playbooks and the skill.
- **Four input modes** for every input of a pack tool: **Fixed** (hidden, filled every call: today's fixed inputs),
  **Default** (shown with the value as its default), **Agent decides**, and **Per person** (hidden, filled with that
  person's own value). The person's value wins, then the pack's variable, then the tool's default. Values are checked
  against the live schema and flagged when it changes.
- **Per-person values** are set in the share sheet; the person sees them on the join page and can change them there
  or later.
- **Pack playbooks**: markdown with front matter declaring arguments, served as MCP prompts, `get_playbook`,
  `/p/<pack>/api/playbooks`, and suggested by search.
- **One skill per pack** (`SKILL.md`, "Working with Career") in six sections: what it is for, which tool for which
  job, values already set, playbooks, gotchas (from the upstream manuals, cut to the pack's tools), and what it can't
  do. Served as `skill://<pack>/SKILL.md`, through `read_resource`, and at the top of the pack's `llms.txt`.
- **Checks on every save**: every tool named is in the pack, every `{{…}}` resolves, tools a read-only key can't run
  are warned about, and a playbook past about 12 steps is asked to split.
- **Stored in the gateway**, every version kept, carried as plain `.md` files by config export and import. A playbook
  or skill records the tool versions it was written against and is flagged when one changes.
- **Build with AI / Refresh with AI** (Settings › AI writer model): from the purpose and a few example tasks it
  proposes tools with reasons, wording, variables, input modes, playbooks and the skill, as a before/after accepted
  line by line. Nothing is saved until accepted.
- **Rehearsal**: before the proposal is shown, each example task runs against the pack. Tools that change things are
  never run: the model gets a stand-in result and the proposal says which steps weren't really tried. Rehearsal calls
  are marked in Activity. Up to **$1** per build or refresh, the estimate shown first and the cost after; at the cap
  it stops and says what wasn't done.
- **The owner's own agents write too.** Authoring routes (`POST /api/packs/{name}/playbooks`, `PUT …/skill`,
  `PUT …/variables`) run the same checks, and `/llms.txt` gains a "Writing a pack" section.

## Screens

The owner's side, in order of a first pack.

```
┌─ Packs / Career ─────────────────────────────────── [ Try it ] [ Share ]
│  Overview   Tools 20   Playbooks & manuals 3   People 2   Activity
│ ─────────────────────────────────────────────────────────────────────
│  Set up Career                                              3 of 4
│   ✓ Describe it   ✓ Add tools   ✓ Try it as the pack   ○ Connect an app
│
│  ┌─ Address ────────────────────────────────────────────────────────
│  │  gw.example.com/p/career                               [ Copy ]
│  │  MCP /p/career/mcp  ·  REST /p/career/api  ·  Docs /p/career/docs
│  └──────────────────────────────────────────────────────────────────
```

```
┌─ Try Career as an agent ─────────────────────────────── See it as: [ Me ▾ ]
│  [ find a remote product design role                          ] [ Search ]
│  1  jobs.search_postings        Search job postings by role, place…
│  2  mail.search_threads         Find email threads by words or sender
│     2 tools stood out · 18 others didn't match
│
│  [ logos                                                       ] [ Search ]
│  Nothing in Career matches "logos".
│  This pack covers: job search, inbox, talks.            [ Add tools ]
```

```
┌─ Share Career ───────────────────────────────────────────────────────
│  Who            [ Sam                                   ]
│  Where          ( ) Claude Code, Cursor, Codex   (•) claude.ai or ChatGPT
│                 ( ) Not sure
│  What they can do (3 tools here change things)   (•) Read only  ( ) Can change
│  How long       ( ) 7 days   (•) 30 days   ( ) Until revoked
│  Sam's values   city [ Lisbon ]
│                                         [ Cancel ]  [ Create invite ]
```

```
┌─ Packs / Career › People ────────────────────────────────────────────
│  ┌─ Waiting to join ────────────────────────────────────────────────
│  │  Lena (ChatGPT) · code 482 913 · 2 min ago   [ Refuse ] [ Approve… ]
│  └──────────────────────────────────────────────────────────────────
│  Person   Connects via          Access      Ends      Last call    7d
│  Me       Claude Code · key     can change  never     2 min ago    41
│  Sam      claude.ai · invite    read only   21 Dec    1 h ago       9
│  Ola      Cursor · key          read only   ⚠ in 3 d  4 d ago       2   [ Extend ]
│  Ask to join [ off ]
```

```
┌─ Career › Tools › jobs.search_postings › Inputs ─────────────────────
│  query        ( ) Fixed  ( ) Default  (•) Agent decides  ( ) Per person
│  location     ( ) Fixed  ( ) Default  ( ) Agent decides  (•) Per person  {{city}}
│  posted_since ( ) Fixed  (•) Default  ( ) Agent decides  ( ) Per person  {{since_days}}
│  account      (•) Fixed  ( ) Default  ( ) Agent decides  ( ) Per person  {{account}}
│  ✓ Every value fits the tool's current schema
```

```
┌─ Proposal for Career ──────────────────────────────── [ Accept all ] [ Discard ]
│  Tools 9        ✓ jobs.search_postings   ✓ mail.search_threads   ✗ mail.send (changes things)
│  Variables 3    city · account · since_days
│  Playbooks 3    Find roles · Reply to a recruiter · Interview prep
│  Skill 1        "Working with Career", 6 sections
│  Rehearsal      Find roles: 2 calls, 14 postings · Reply: draft written, send skipped
│  Cost           $0.31 of $1.00
```

The other person's side.

```
┌─ gw.example.com/p/career/join/K7Q-4MD ───────────────────────────────
│   Career
│   Job search: find postings, read replies, prep with talks.
│   Ada invited Sam · read only · until 21 Dec · city: Lisbon [ change ]
│   Add it to:  claude.ai │ ChatGPT │ Claude Code │ Cursor
│   1  Settings › Connectors › Add custom connector
│   2  Paste  gw.example.com/p/career/mcp                    [ Copy ]
│   3  Press Connect, then Approve.
```

```
┌─ Connect Claude to Career ─────────────────┐  ┌─ Connect to Career ──────────────────────
│  claude.ai wants to use Career for Sam.    │  │  Have an invite code? [ K7Q-4MD ] [ Continue ]
│  Read only · until 21 Dec · invited by Ada │  │  ─── or ───
│                    [ Cancel ]  [ Approve ] │  │  Your name [ Lena ] [ Ask Ada to let you in ]
└────────────────────────────────────────────┘  └──────────────────────────────────────────
```

What the agent sees:

```
Server: Career
> search_tools "logos"
  Nothing in Career matches "logos". This pack covers: job search, inbox, talks.
> list_upstreams
  jobs: Jobs board, 6 tools · mail: Mail, 4 tools · talks: Talks archive, 10 tools
> call_tool …   (after 21 Dec)
  Your access to Career ended on 21 Dec. Ask Ada for a new invite.
```

## Alternatives not taken

- **A pack lists all its tools and drops search.** Simpler and noise-free, but a pack must work like the gateway,
  REST and docs included, and a large pack would flood an agent's context.
- **Compute the search bar over the pack.** Twenty rows give no stable spread; nearly every query would return nothing.
- **A subdomain per pack.** The most "own server" feel, but a wildcard DNS name and certificate per install.
- **Keep the sign-in behind the owner's front door and add each person to it.** Strong, but per-install work for
  every share, and installs without such a door get nothing.
- **A git repo as the source of a pack's playbooks and skill.** Reviewable, but the app's editor and AI drafts would
  have to commit to git; export as `.md` keeps that option open.
- **Running tools that change things during rehearsal.** Most thorough, but a draft could send real mail before the
  owner has read it.

## Consequences

- Every key's search changes with the standout bar; logged searches are replayed to pick it, and the result goes in
  the release notes.
- Existing pack connections change shape: their tools are found by search, not all listed. The release notes say so.
- A public sign-in path exists for the first time. It is its own security review before release: invites single-use
  and short-lived, Ask to join off by default, rate limits per address and per pack.
- New tables: pack variables, per-person values, pack playbooks and skills with versions, invites, join requests,
  and pack name history.

## Rollout

| Pull request | What | Rough size |
|---|---|---|
| 1 | The pack as its own server: `/p/<pack>/`, the gateway's shape, its own counts, standout search, the empty hint, Overview checklist, Try it, Address card | about 1.5 days |
| 2 | Sharing with key-based apps: People, Share, lifetimes, endings, renaming | about 1 day |
| 3 | claude.ai and ChatGPT: invite links, the public sign-in, Ask to join | about 1 day, plus a security review |
| 4 | Authoring: variables and input modes, pack playbooks and skill, Build and Refresh with AI with rehearsal, authoring routes | about 4 days |
