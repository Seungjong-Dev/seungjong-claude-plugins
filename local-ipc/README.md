# local-ipc

A 1:1 local message channel for Claude Code. Two or more Claude Code
sessions on the same machine can exchange directed messages via a filesystem
queue — e.g. an orchestrator agent coordinating with a worker agent without
going through any external service.

> Durable, completion-tracked **tasks** are no longer part of this plugin (as
> of 0.3.0). They are owned by cete-os-server, which delivers its nudges as
> ordinary `from="tasks"` messages into the same inbox — so this stays a pure
> message channel and the inbox contract below is frozen for that bridge.

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

## Notes

- No auth, no network. Sender identity is self-declared by `$LOCAL_IPC_AGENT_NAME`
- Messages are **best-effort (at-most-once)**: delivered once via a channel push, then unlinked — no replay. A message queued for an offline peer is drained on its next launch, but the push only wakes the session once it's in steady-state idle-listening, so a message delivered during that startup window can be missed. If a message must not be lost, use a durable mechanism outside this channel.
- `registered.json` is refreshed on every startup and removed on graceful shutdown (SIGKILL leaves a stale file; next startup overwrites)

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `LOCAL_IPC_AGENT_NAME` | (required) | This session's agent name. Must be set by launcher. |
| `LOCAL_IPC_DIR` | `~/.claude/channels/local-ipc` | Root directory for inbox queues and registration files. |

## License

MIT
