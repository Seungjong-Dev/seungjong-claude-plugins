# seungjong-claude-plugins

Personal Claude Code plugin marketplace maintained by [@Seungjong-Dev](https://github.com/Seungjong-Dev).

## Plugins

| Name | Description |
|---|---|
| [`local-ipc`](./local-ipc) | Local inter-session IPC channel — two or more Claude Code sessions on the same machine exchange messages via a filesystem queue. |

## Install

Add this repo to `~/.claude/settings.json`:

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

Then use the plugin as described in its own README.

## License

MIT (per-plugin `package.json` unless noted otherwise).
