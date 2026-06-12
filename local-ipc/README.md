# local-ipc

Local inter-session IPC channel for Claude Code. Two or more Claude Code
sessions on the same machine can exchange messages via a filesystem queue —
e.g. an orchestrator agent delegating tasks to a worker agent without going
through any external service.

## How it works

```
$LOCAL_IPC_DIR/<recipient>/inbox/<ts>-<uuid>.json
  { "from": "<sender>", "ts": "<iso>", "text": "<body>" }
```

- Default `$LOCAL_IPC_DIR` = `~/.claude/channels/local-ipc`
- Each session watches `$LOCAL_IPC_DIR/$LOCAL_IPC_AGENT_NAME/inbox` via `fs.watch`
- On new file: server emits `notifications/claude/channel` with `source="local-ipc"`, then unlinks the file (at-most-once delivery)
- `send` tool drops a file into the recipient's inbox
- Each session publishes a `registered.json` so peers can discover active agents

## Install

1. Register this marketplace in `~/.claude/settings.json`:

   ```json
   {
     "extraKnownMarketplaces": {
       "seungjong-claude-plugins": {
         "source": {
           "source": "github",
           "repo": "Seungjong-Dev/seungjong-claude-plugins"
         }
       }
     },
     "enabledPlugins": {
       "local-ipc@seungjong-claude-plugins": true
     }
   }
   ```

2. In each session's launcher, export a unique agent name:

   ```bash
   export LOCAL_IPC_AGENT_NAME=agent-a   # or agent-b, worker, orchestrator, …
   ```

   Names must be lowercase alphanumeric / underscore / hyphen, 1–32 chars.

3. Launch the session with the channel enabled:

   ```bash
   claude --channels plugin:local-ipc@seungjong-claude-plugins
   ```

## Usage from Claude

- **Incoming**: messages arrive as
  `<channel source="local-ipc" from="<sender>" ts="<iso>">text</channel>`
- **Outgoing**: call the `send` tool with `{ to: "<recipient>", text: "..." }`
- **Discovery**: call the `list_agents` tool to see which peers are currently registered (with `alive` liveness hint via signal 0)

## Tasks (durable delegation)

Beyond ephemeral messages, agents can delegate **tasks** — durable records tracked to completion. Use a message when you need a reply; use a task when work must be tracked to done/failed.

- **Create**: `assign_task { target, title, body?, priority? }` — writes a durable record for `target` (offline targets are queued and delivered on their next launch).
- **Receive**: the target is nudged (`from="tasks"`) to call `my_tasks`, which lists tasks where it is the target (defaults to open + claimed).
- **Lifecycle**: `claim_task { id }` (open → claimed) → `complete_task { id, result? }` (→ done) or `fail_task { id, error? }` (→ failed). `cancel_task { id }` cancels an open/claimed task. Transitions are idempotent.

Records live at `~/.claude/channels/local-ipc/_store/tasks/<target>__<id>.json` (`schema_version: 1`); terminal tasks (done/failed/cancelled) are garbage-collected after 7 days. Writes are atomic (tmp + `rename()`). Delivery reuses the same single-owner (`ownsInbox`) gate as the message inbox, so a zombie same-name session can't steal nudges; because the record is the source of truth, a missed nudge is recovered on the next launch or `my_tasks` call.

## Notes

- No auth, no network. Sender identity is self-declared by `$LOCAL_IPC_AGENT_NAME`
- Messages are **best-effort (at-most-once)**: delivered once via a channel push, then unlinked — no replay. A message queued for an offline peer is drained on its next launch, but the push only wakes the session once it's in steady-state idle-listening, so a message delivered during that startup window can be missed. **If a message must not be lost, use a task** — its durable record survives and the recipient can always pull it with `my_tasks`.
- Tasks re-nudge the target a few times (default every 20s, see `LOCAL_IPC_RENUDGE_MS` / `LOCAL_IPC_RENUDGE_MAX`) so the wake lands even if the first nudge was too early; after that the durable record remains pullable
- `registered.json` is refreshed on every startup and removed on graceful shutdown (SIGKILL leaves a stale file; next startup overwrites)

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `LOCAL_IPC_AGENT_NAME` | (required) | This session's agent name. Must be set by launcher. |
| `LOCAL_IPC_DIR` | `~/.claude/channels/local-ipc` | Root directory for inbox queues and registration files. |
| `LOCAL_IPC_RENUDGE_MS` | `20000` | Interval between task re-nudges while open tasks persist. |
| `LOCAL_IPC_RENUDGE_MAX` | `6` | Max task re-nudges before going quiet (record stays pullable via `my_tasks`). |

## License

MIT
