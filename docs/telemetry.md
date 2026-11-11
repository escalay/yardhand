# Usage telemetry

Yardhand is self-hosted, so nothing tells its maintainers how many instances run, how far their owners get through
setup, or which parts are used. Once a day an instance sends one small anonymous report that answers those questions
in ranges and yes/no answers. It carries no name, address, query or key, and nothing a call carried.

You can read the exact report before it is ever sent, and switch it off with one line.

## The default, and switching it off

Telemetry is on unless the environment says otherwise. Either line in `.env` switches it off; then restart
(`docker compose up -d`):

```sh
GATEWAY_TELEMETRY=off
```

```sh
DO_NOT_TRACK=1
```

| Setting | Values | What it does |
|---|---|---|
| `GATEWAY_TELEMETRY` | `off` (also `false`, `0`, `no`); anything else is on | Off sends nothing, ever |
| `DO_NOT_TRACK` | `1` (also `true`) | The same switch other tools honour; it wins over `GATEWAY_TELEMETRY` |
| `GATEWAY_TELEMETRY_URL` | an address | Where reports go; unset, `https://pulse.escalay.space/v1/yardhand` |

There is no switch in the app, on purpose: the setting lives where the instance runs, so nothing in the app, and no
one signed in to it, can turn it back on. Settings says whether it is on and which variable switched it off.

## The first report waits 24 hours

A new instance sends nothing for its first day. So does an instance that upgrades to the first version with
telemetry. The day starts when that version first runs, and before it is over the notice is shown three times: in the
log at every start, in the guided setup, and on the overview. After that, one report goes each day. A send that fails
is tried again within the hour; nothing is queued up, so a day offline is a day without a report.

## See your own report

- **In the app:** Settings › Usage telemetry shows whether it is on, where it sends, when the first or last report
  went, every field with its value, and the JSON as it is posted.
- **Over the API** (owner key): reading it sends nothing.

```sh
curl -H "Authorization: Bearer $OWNER_KEY" https://gateway.example.test/api/system/telemetry
```

`next` is what would be sent now, `sent` the last report as it went (null until one has), `firstAt` the end of the
24-hour wait.

## What is sent

One JSON document, posted over HTTPS:

```json
{
  "schema": 1,
  "instance": "0b9d2c1e-1111-4222-8333-444455556666",
  "version": "0.2.0",
  "report": { "install": "compose", "arch": "arm64", "connections": "1-10", "https": true }
}
```

| Beside the report | Meaning |
|---|---|
| `schema` | The number of the field list below. A new field is a new number, never a quiet addition |
| `instance` | A random id made on the first day and kept by the instance. It is derived from nothing: not the host, the address, the owner or a key. It only lets two days' reports be counted as one instance |
| `version` | The Yardhand version that runs |

Counts are never exact. A count is one of `0`, `1-10`, `11-100`, `101-1k`, `1k-10k`, `10k+`.

### Schema 1

Where it runs:

| Field | Meaning | Values |
|---|---|---|
| `install` | How it was installed, as the template that started it says (`GATEWAY_INSTALL`) | `compose`, `cloud-init`, `render`, `fly`, `source`, `other` |
| `arch` | The processor | `x64`, `arm64`, `other` |
| `age` | Days since it first ran a version with telemetry | `0`, `1-7`, `8-30`, `31-90`, `91-365`, `365+` |
| `https` | Its own address (`PUBLIC_HOST`) starts with `https://`. The address itself is not sent | yes/no |
| `database` | The size of the database file | `<10MB`, `10-100MB`, `100MB-1GB`, `1GB+` |

Setup:

| Field | Meaning | Values |
|---|---|---|
| `claimed` | It has an owner | yes/no |
| `connections` | Connections of any kind, the sample tools included | a count |
| `connections_mcp` | At least one connection is an MCP server | yes/no |
| `connections_http` | At least one is a REST API | yes/no |
| `connections_composio` | At least one is Composio | yes/no |
| `tools` | Tools it holds | a count |
| `clients_key` | Agents with a key that is not revoked | a count |
| `clients_oauth` | Agents signed in with OAuth, not revoked | a count |
| `packs` | Packs | a count |
| `reviews_waiting` | Changes waiting for review | a count |

Use over 7 days:

| Field | Meaning | Values |
|---|---|---|
| `calls_1d` | Calls in the last day | a count |
| `calls` | Calls in the last 7 days | a count |
| `calls_mcp` | Of those, over MCP | a count |
| `calls_rest` | Of those, over REST or the passthrough | a count |
| `calls_app` | Of those, from the app | a count |
| `calls_tool_error` | Of those, the tool answered with an error | a count |
| `calls_refused` | Of those, refused by the gateway | a count |
| `calls_failed` | Of those, the upstream failed | a count |
| `searches` | Tool searches | a count |
| `clients_active` | Agents that made a call | a count |

Failures are counted by how the call log says a call ended, never by an error's message.

Optional parts:

| Field | Meaning | Values |
|---|---|---|
| `meaning_search` | Search by meaning is on | yes/no |
| `ai_grouping` | The kind of provider smart grouping has a key for. Never its address, model or key | `off`, `openrouter`, `openai`, `local`, `custom` |
| `langfuse` | Call traces go to Langfuse | yes/no |
| `discord` | Review alerts go to a Discord webhook | yes/no |
| `access_signin` | Cloudflare Access signs the owner in | yes/no |

## What is never sent

- The instance's address or host name, or the owner's name or email.
- The name, title or address of any connection, tool, agent, pack or group.
- Anything a call carried: arguments, results, error messages.
- What agents searched for.
- Keys, tokens, credentials or anything from the vault.
- Exact numbers.

A test in the repo (`apps/gateway/test/telemetry.test.ts`) connects a server with a telling name and fails if any of
it shows in the report, and holds the report to the field list above.

## What the collector adds

The collector is a small Cloudflare Worker. On receiving a report it adds two things: the day, and the country the
request came from, as Cloudflare names it. The sender's IP address is not stored. A report that carries any field
outside its schema is refused whole.

Its answer names the newest Yardhand release, which Settings shows as "A newer version is out" when it is newer than
the one running. That is the only thing an instance takes from the collector.

## How long it is kept

One row per instance per day, kept for 13 months. After that, rows are rolled into monthly totals that hold no
instance ids, and the daily rows are deleted.

## Your own collector

For a fork or a fleet, point reports at your own address:

```sh
GATEWAY_TELEMETRY_URL=https://pulse.example.test/v1/yardhand
```

The collector's source, with the schema file each product's reports are checked against, is at
[github.com/escalay/pulse](https://github.com/escalay/pulse). Any server that accepts the JSON above with a `POST`
and answers 2xx works; a `latest` string in a JSON answer is shown as the newest release.

## Tests and demos never send

The test suite and the demo gateways (`pnpm demo`, `pnpm e2e`) run no jobs, and the self-hosting smoke test sets
`GATEWAY_TELEMETRY=off`.
