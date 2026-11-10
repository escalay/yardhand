# Architecture

Layers, top to bottom: **clients** → **front doors** (`/mcp`; REST under `/api` with runs at `POST /api/calls` and the tools as OpenAPI at `/api/tools/openapi.json`; passthrough `/u/{upstream}/mcp`; link proxy `/u/{upstream}/r/*`; `/oauth/*`; `/app` behind the owner's sign-in) → **core** pipeline → **adapters** (`mcp`, `http`, `composio`, `sample`) → **upstreams**. State beside the core: SQLite (registry, clients, pins, call log), the AES-GCM vault, the master key in `instance.json` or the environment, the meaning-search ledger, nightly snapshots in `/state/backups`.

## Call pipeline

authenticate → allowlist → scope (write tools need write) → resolve (live version) → arguments checked against the schema (defaults filled) → credential (key, or OAuth token refreshed by the SDK) → adapter call (one retry for reads on a stale connection) → links rewritten to the proxy → cap (MCP only, per client) → audit (call row, sealed payload 30 days, Langfuse metadata when configured).

## Flows

### A. An agent finds a tool and calls it

Claude Code connects once, searches across all upstreams and calls cookbook. Most calls take this path.

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent (Claude Code)
  participant G as Yardhand /mcp
  participant R as Registry (SQLite)
  participant U as docs.example.test/mcp
  A->>G: initialize with client key
  G-->>A: instructions + meta-tools + this client's pinned tools
  A->>G: search_tools q = "a quick dinner recipe"
  G->>R: keyword + vector search, only allowed upstreams
  R-->>G: ranked tools
  G-->>A: cookbook.research_recipes, cookbook.search_recipes, ...
  A->>G: describe_tool cookbook.research_recipes
  G-->>A: input schema + when to use it
  A->>G: call_tool cookbook.research_recipes with args
  G->>G: scope check, decrypt cookbook key
  G->>U: tools/call research_recipes
  U-->>G: result
  G->>G: cap size, write call log, Langfuse metadata
  G-->>A: result, or first part + result id
```

### B. A script calls the same tool over REST

No MCP client in the script: one HTTP call, or the typed client generated from /api/tools/openapi.json.

```mermaid
sequenceDiagram
  autonumber
  participant S as Script (report.ts)
  participant G as Yardhand REST
  participant C as Composio MCP
  S->>G: GET /api/tools/openapi.json (once, pnpm gen:client)
  S->>G: POST /api/calls with tool composio.GMAIL_FETCH_EMAILS and query
  G->>G: script key allows composio only, read scope is enough
  G->>C: tools/call with Composio API key from the vault
  C-->>G: messages
  G->>G: call log + Langfuse metadata, no size cap on REST
  G-->>S: 200 JSON, structured result when the tool declares one
```

### C. claude.ai connects for the first time

The kit's OAuth server; you approve as the signed-in owner; the new client starts with the default allowlist.

```mermaid
sequenceDiagram
  autonumber
  participant C as claude.ai
  participant G as Yardhand
  participant Y as You
  C->>G: POST /mcp without a token
  G-->>C: 401 + link to resource metadata
  C->>G: read protected-resource and authorization-server metadata
  C->>G: POST /oauth/register (dynamic client registration)
  C->>G: GET /oauth/authorize with PKCE challenge
  G-->>Y: consent page, for the signed-in owner only
  Y->>G: sign in (the owner key, or Cloudflare Access when it is in front)
  Y->>G: approve the client
  G->>G: create client with default allowlist and pins
  G-->>C: redirect with code
  C->>G: POST /oauth/token with code + verifier
  G-->>C: access token (read, write) + refresh token
  C->>G: POST /mcp with token, flow A continues
```

### D. You add a new upstream in the UI

Adding a server: an MCP URL or an OpenAPI spec, a key, a trust level. Live in about a minute.

```mermaid
sequenceDiagram
  autonumber
  participant Y as You in /app
  participant G as Yardhand
  participant V as Vault (AES-GCM in SQLite)
  participant U as New upstream
  Y->>G: add upstream with kind, URL, auth header, trust level
  G->>V: encrypt the secret with the master key
  alt kind mcp
    G->>U: initialize + tools/list
    U-->>G: server instructions + tools
  else kind http
    G->>U: GET the OpenAPI spec
    U-->>G: operations with schemas
  end
  G-->>Y: preview, tick which tools to expose
  Y->>G: save
  G->>G: store tool versions + hashes, index for search
  G-->>Y: live over MCP, REST and passthrough
```

### E. You connect an OAuth upstream

This time the gateway is the OAuth client: discover, register, consent, store tokens, refresh them silently.

```mermaid
sequenceDiagram
  autonumber
  participant Y as You in /app
  participant G as Yardhand
  participant F as mcp.example.test
  participant AS as Its auth server
  Y->>G: Connect it
  G->>F: POST /mcp without a token
  F-->>G: 401 + resource metadata
  G->>AS: read metadata, register the gateway as a client
  G-->>Y: redirect to its consent page with PKCE
  Y->>AS: approve
  AS-->>G: callback with code
  G->>AS: exchange code for tokens
  G->>G: encrypt tokens, sync tools (review needed, third party)
  Note over G,AS: on expiry or 401 the gateway refreshes, rotates and retries once
```

### F. An upstream changes its tools

Your own upstreams go live on sync. Third-party changes wait for your review, so a quietly rewritten tool description can't slip injected instructions past you.

```mermaid
sequenceDiagram
  autonumber
  participant J as Sync (on a schedule + list_changed)
  participant U as Upstream
  participant G as Registry
  participant Y as You in /app
  J->>U: tools/list
  U-->>J: tools
  J->>G: compare description + schema hashes
  alt trusted (servers you run)
    G->>G: new version goes live, search index refreshed
  else third party (anything else)
    G->>G: mark pending, old version keeps serving
    G-->>Y: badge + diff of what changed
    Y->>G: approve or reject
  end
```

### G. A result is too big for the agent

The gateway returns the first part and a handle; the agent pages only if it needs more.

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant G as Yardhand
  participant U as assets.example.test
  A->>G: call_tool atlas.search_places
  G->>U: tools/call
  U-->>G: ~90k tokens of results
  G->>G: over this client's cap (25k), keep the full result briefly
  G-->>A: first 25k + call id c_7f3 + how to get more
  A->>G: get_result c_7f3 page 2
  G->>G: same as GET /api/calls/c_7f3/result?page=2
  G-->>A: next part
```

## Data model

```mermaid
erDiagram
  UPSTREAM ||--o{ TOOL : exposes
  TOOL ||--|{ TOOL_VERSION : "versions"
  UPSTREAM ||--o| SECRET : "authenticates with"
  UPSTREAM ||--o| OAUTH_CONNECTION : "connected by"
  CLIENT ||--o{ CLIENT_UPSTREAM : "is allowed"
  UPSTREAM ||--o{ CLIENT_UPSTREAM : "allowed for"
  CLIENT ||--o{ PIN : "overrides"
  TOOL ||--o{ PIN : "pinned as"
  CLIENT ||--o{ CALL : makes
  TOOL_VERSION ||--o{ CALL : "ran as"
  CALL ||--o| CALL_PAYLOAD : "payload"
  CALL ||--o| HELD_RESULT : "continuation"
  UPSTREAM {
    text id PK
    text kind "mcp http composio sample"
    text endpoint "URL, spec URL or command"
    text trust "trusted or review"
    text instructions "from the server"
    text status "live, paused, failing"
  }
  TOOL_VERSION {
    text id PK
    text tool_id FK
    text hash "description + schemas"
    text state "live, pending, rejected"
    json input_schema
    json output_schema
    json annotations
  }
  CLIENT {
    text id PK
    text name
    text auth "api key or oauth"
    text scope "read or write"
    int result_cap_tokens
  }
  PIN {
    text client_id "null means global default"
    text tool_id
  }
  SECRET {
    text upstream_id FK
    blob ciphertext "AES-GCM"
  }
  CALL {
    text id PK
    text client_id FK
    text tool_version_id FK
    text status
    int duration_ms
    int result_bytes
  }
  CALL_PAYLOAD {
    text call_id FK
    blob ciphertext "args + result, 30 days"
  }
```
