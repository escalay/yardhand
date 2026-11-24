# Yardhand

An agent-ready HTTP API built on agent-api-kit, vendored into `src/kit`. Every route is documented OpenAPI, every answer HAL, every error problem+json, and every route
an MCP tool.

## Commands

`pnpm install` · `pnpm test` · `pnpm typecheck` · `pnpm guide` (after editing `guide/`)

- `pnpm dev`: the API on Node at http://localhost:4400 (`/docs`, `/llms.txt`, `/mcp`)

A new feature: a folder under `src/features/<plural-name>/` with its schema, repo, routes and handlers, listed in
`src/features/index.ts`; copy the shape of a small one such as `backups`.

## Layout

| Path | What |
|---|---|
| `src/server.ts` | Node: env → `openDb` → `createApp` → listen |
| `src/guide.gen.ts` | `guide/` as a module (`pnpm guide`), served the same on both runtimes; a test fails when it is older than `guide/` |
| `src/app.ts` | the wiring only: auth and OAuth, every feature, the guide, MCP |
| `src/features/index.ts` | `FEATURES`, the one list of features, and the `Feature` shape |
| `src/features/<name>/` | one feature: `schema.ts` (tables + migration steps) · `repo.ts` (the only queries) · `routes.ts` (OpenAPI contracts) · `handlers.ts` (request → repo → HAL) · `tools.ts` (MCP tools) · `index.ts` (register, tools, sample tool arguments) · `<name>.test.ts` |
| `src/kit/` | the vendored kit, never edited here; `kit.json` records its version, and each module's `README.md` says what it is for and its rules (start with `core`, `db`, `mcp`, `testing`). A change goes to the kit first; then `npx @escalay/kit@<version> update --force --dir src/kit`, and `kit doctor` reports nothing |
| `guide/` | the agent guide: templates whose `{{api.endpoints}}` and `{{mcp.tools}}` are generated from the code. Every `{{word}}` there is a placeholder: one to be read as written is written `{{open}}word}}` (`src/guide.vars.ts`) |
| `test/api.test.ts` | every route linted, every MCP tool run (`toolsRun`), every guide placeholder filled |
| `container/entrypoint.sh` | the env allowlist: the API sees only the variables it reads |

## Rules

- Only a feature's `repo.ts` queries the database; handlers call the repo. That keeps a move off SQLite to one file
  per feature (`openDb` takes any Drizzle SQLite database: Turso via `drizzle-orm/libsql`, D1 via `drizzle(env.DB)`).
- A migration step never changes once it has run anywhere; a change is a new step at the end of the list.
- A new env var the API reads goes into `container/entrypoint.sh` too.
