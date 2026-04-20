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

## Notes

- No auth, no network. Sender identity is self-declared by `$LOCAL_IPC_AGENT_NAME`
- Offline messages queue in the recipient's inbox and deliver on next launch (server drains on connect)
- Messages are unlinked after delivery — no replay
- `registered.json` is refreshed on every startup and removed on graceful shutdown (SIGKILL leaves a stale file; next startup overwrites)

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `LOCAL_IPC_AGENT_NAME` | (required) | This session's agent name. Must be set by launcher. |
| `LOCAL_IPC_DIR` | `~/.claude/channels/local-ipc` | Root directory for inbox queues and registration files. |

## License

MIT
