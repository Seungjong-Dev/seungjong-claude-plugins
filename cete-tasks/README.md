# cete-tasks

Agent-facing **task tools** for Claude Code — `assign_task`, `my_tasks`,
`claim_task`, `complete_task`, `fail_task`, `cancel_task` — backed by
[cete-os-server](../) (SQLite SSOT + REST). This is the drop-in replacement for
the task primitive that [local-ipc](../local-ipc) carried before 0.3.0: same six
tool names and semantics, but durable state lives on the server instead of a
local filesystem store.

Use a **task** when work must be tracked to done/failed or survive the target
being offline; use local-ipc's `send` **message** for conversational replies.

## How it works

```
cete-tasks (this plugin)  ──HTTP──▶  cete-os-server  ──▶  SQLite (source of truth)
        ▲                                   │
        │  my_tasks (pull truth)            │  on assign: drop a from="tasks"
        │                                   ▼  message into the target's
   agent session  ◀────────────────  local-ipc inbox  (the nudge)
```

- The plugin is a **thin REST client** — each tool is one HTTP call. No nudge or
  watch logic lives here.
- **Delivery / nudge** is handled out-of-band: when a task is assigned,
  cete-os-server drops a `from="tasks"` message into the target's local-ipc
  inbox, and local-ipc delivers it as a channel message telling the agent to
  call `my_tasks`. Because the server is the source of truth, a missed nudge is
  always recoverable by calling `my_tasks`.

## Tools

| Tool | Maps to | Notes |
|---|---|---|
| `assign_task(target, title, body?, priority?)` | `POST /tasks` (stamps `created_by=$AGENT`) | returns the new task id |
| `my_tasks(status?)` | `GET /tasks?target=$AGENT` | default: filtered to **active** (`open`+`claimed`) client-side; pass `status` to query a single state |
| `claim_task(id)` | `POST /tasks/{id}/claim` | open → claimed |
| `complete_task(id, result?)` | `POST /tasks/{id}/complete` | claimed → done |
| `fail_task(id, error?)` | `POST /tasks/{id}/fail` | claimed → failed |
| `cancel_task(id)` | `POST /tasks/{id}/cancel` | open/claimed → cancelled |

All writes stamp `$AGENT` as `created_by` / `actor`.

## Errors

- **409** invalid transition → `cannot <verb>: <server error>`
- **404** → `task <id> not found`
- **connection refused / network error** → `cete-os-server unreachable at <url>`
  (tasks require the server up; local-ipc messaging still works independently)
- other non-2xx → the server's `{ok:false,error}` message is surfaced verbatim

## Configuration (env)

| Name | Default | Purpose |
|---|---|---|
| `CETE_OS_SERVER_URL` | `http://127.0.0.1:8787` | Base URL of cete-os-server. |
| `CETE_OS_SERVER_SECRET` | (required) | Shared secret, sent as the `X-Auth` header. |
| `CETE_TASKS_AGENT_NAME` | falls back to `LOCAL_IPC_AGENT_NAME` | This agent's identity (target / created_by / actor). |

Agent identity reuses `LOCAL_IPC_AGENT_NAME` so it stays consistent with the
local-ipc message channel — set one name per session and both plugins agree.

## Notes

- Unlike local-ipc (which is standalone), this plugin **depends on
  cete-os-server** being reachable — it's part of the cete stack.
- No nudge/re-nudge logic here by design; that lives in the server's delivery
  bridge through local-ipc.

## License

MIT
