#!/usr/bin/env bun
/**
 * Local inter-session IPC channel for Claude Code.
 *
 * Each Claude Code session that loads this plugin becomes a node identified
 * by $LOCAL_IPC_AGENT_NAME (set by its launcher). Messages are exchanged via
 * a shared filesystem queue:
 *
 *   $LOCAL_IPC_DIR/<recipient>/inbox/<ts>-<uuid>.json
 *
 * Each session watches its own inbox with fs.watch; new files are parsed,
 * delivered to Claude as a `<channel source="local-ipc" ...>` block via the
 * `notifications/claude/channel` MCP extension, then unlinked.
 *
 * The `send` tool writes a message file into the recipient's inbox. On
 * startup the server also publishes a `registered.json` under its own
 * directory so peers can discover active agents without needing to know
 * names in advance.
 *
 * This is a pure 1:1 message channel. Durable, completion-tracked tasks are
 * owned by cete-os-server (SQLite SSOT + REST), which delivers its nudges as
 * ordinary `from="tasks"` messages dropped into the same inbox — so the
 * message contract here (path layout, payload keys, watch→drain) is frozen.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  watch,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { isValidAgentName } from './names'
import { SCHEMA } from './schema'
import {
  shouldSelfReap, shouldReapPredecessor, parseProcStart, type Registration,
} from './reap'

const PLUGIN_VERSION = '0.3.0'

// Reaping config (env-overridable for tests). REAP_PREDECESSOR gates the
// startup active kill (B); SELFCHECK gates the periodic ownership self-exit (A).
// Set either to its disable value to isolate one mechanism under test.
const REAP_PREDECESSOR = process.env.LOCAL_IPC_REAP_PREDECESSOR !== '0'
const REAP_GRACE_MS =
  process.env.LOCAL_IPC_REAP_GRACE_MS !== undefined ? Number(process.env.LOCAL_IPC_REAP_GRACE_MS) : 2_000
const SELFCHECK_INTERVAL_MS =
  process.env.LOCAL_IPC_SELFCHECK_MS !== undefined ? Number(process.env.LOCAL_IPC_SELFCHECK_MS) : 15_000

const AGENT = process.env.LOCAL_IPC_AGENT_NAME
if (!AGENT || !isValidAgentName(AGENT)) {
  process.stderr.write(
    `local-ipc: LOCAL_IPC_AGENT_NAME required (lowercase alphanumeric/_/-, 1-32 chars, not a reserved name). Set in launcher.\n`,
  )
  process.exit(1)
}

const BASE =
  process.env.LOCAL_IPC_DIR ??
  join(homedir(), '.claude', 'channels', 'local-ipc')
const MY_DIR = join(BASE, AGENT)
const MY_INBOX = join(MY_DIR, 'inbox')
const MY_REGISTRATION = join(MY_DIR, 'registered.json')
mkdirSync(MY_INBOX, { recursive: true, mode: 0o700 })

// Publish our registration so peers can discover us. We refresh this on every
// startup — stale files from crashed sessions will be overwritten when the
// agent restarts. Consumers should treat `pid` liveness as advisory, not
// authoritative (see `send` tool for how we use it).
function writeRegistration(): void {
  const payload = {
    name: AGENT,
    pid: process.pid,
    version: PLUGIN_VERSION,
    registered_at: new Date().toISOString(),
  }
  writeFileSync(MY_REGISTRATION, JSON.stringify(payload, null, 2), { mode: 0o600 })
}

/**
 * (B) Actively reap a superseded predecessor. The disconnect→reconnect path
 * spawns us alongside the old server without closing its stdin, so its stdin-EOF
 * self-reap never fires (see comment below) — we must take it down ourselves.
 * SIGTERM lets it run its own releaseAndExit (which preserves OUR registration,
 * since it only unlinks when it still owns the file); a SIGKILL fallback after a
 * grace handles a wedged process. The grace timer re-verifies identity so a pid
 * recycled during the window is never the friendly-fire victim.
 */
function reapPredecessor(prev: Registration): void {
  process.stderr.write(
    `local-ipc: reaping superseded predecessor pid ${prev.pid} for "${AGENT}" (SIGTERM, SIGKILL after ${REAP_GRACE_MS}ms)\n`,
  )
  try { process.kill(prev.pid, 'SIGTERM') } catch {}
  setTimeout(() => {
    // Re-run the full guard: if it's still our live predecessor, finish the job.
    if (shouldReapPredecessor(prev, process.pid, isPidAlive, procStartMs)) {
      try { process.kill(prev.pid, 'SIGKILL') } catch {}
    }
  }, REAP_GRACE_MS).unref?.()
}

// A previous registration for our agent name means an earlier session. Claim
// ownership FIRST (writeRegistration) so that when we SIGTERM the predecessor,
// its releaseAndExit sees it no longer owns the file and leaves our registration
// intact. Then, if it's a verifiable live predecessor, reap it (B) so only one
// watcher per agent survives; otherwise fall back to advisory takeover —
// ownsInbox() and the self-check (A) neutralize whatever we can't positively id.
let predecessor: Registration | null = null
try {
  predecessor = JSON.parse(readFileSync(MY_REGISTRATION, 'utf8')) as Registration
} catch {
  predecessor = null // no previous registration (or unreadable) — nothing to reap.
}
writeRegistration()
if (predecessor) {
  if (REAP_PREDECESSOR && shouldReapPredecessor(predecessor, process.pid, isPidAlive, procStartMs)) {
    reapPredecessor(predecessor)
  } else if (predecessor.pid !== process.pid && isPidAlive(predecessor.pid)) {
    process.stderr.write(
      `local-ipc: agent "${AGENT}" already registered by live pid ${predecessor.pid}; ` +
        `taking over ownership as pid ${process.pid} (could not verify for reap; stale process will stop draining)\n`,
    )
  }
}

// Graceful cleanup — remove our registration so peers immediately see us as
// gone. Non-graceful exits (SIGKILL, crash) will leave the file; next startup
// overwrites it. Only unlink if we still own the registration: a stale
// process (same agent name) dying later must not destroy the current owner's
// file (2026-06-08: momo's registration wiped by a zombie's cleanup).
function releaseAndExit(): void {
  try {
    const reg = JSON.parse(readFileSync(MY_REGISTRATION, 'utf8')) as Registration
    if (reg.pid === process.pid) unlinkSync(MY_REGISTRATION)
  } catch {}
  process.exit(0)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, releaseAndExit)
}

// The stdio transport only listens for stdin 'data'/'error', never EOF. When the
// client disconnects (e.g. the plugin is disabled), the parent closes our stdin
// but the transport never notices — leaving this process orphaned (ppid=1) still
// watching inboxes. Stacked across reloads, those zombie watchers each drain and
// deliver, causing duplicate messages. Treat stdin end/close as a disconnect and
// reap ourselves so only one live watcher per agent survives. Skip when stdin is
// a TTY (a dev running server.ts by hand) so Ctrl+D doesn't look like a disconnect.
if (!process.stdin.isTTY) {
  process.stdin.on('end', releaseAndExit)
  process.stdin.on('close', releaseAndExit)
}

// (A) Periodic ownership self-check. The stdin-EOF reap above only fires when
// the parent actually closes our stdin; a disconnect→reconnect spawns a fresh
// server beside us and leaves our stdin open, so EOF never comes. Instead, poll
// our own registration: once a newer, live pid owns it, we are by definition the
// superseded orphan — exit. releaseAndExit() won't touch the file (it only
// unlinks when WE own it), so the live owner's registration is preserved. Runs
// regardless of clientReady so an orphan that never initialized still reaps.
function selfCheckOwnership(): void {
  let reg: Registration | null = null
  try {
    reg = JSON.parse(readFileSync(MY_REGISTRATION, 'utf8')) as Registration
  } catch {
    reg = null // missing/corrupt — ownsInbox() reclaims; nothing to self-reap.
  }
  if (shouldSelfReap(reg, process.pid, isPidAlive)) {
    process.stderr.write(
      `local-ipc: registration for "${AGENT}" taken over by live pid ${reg!.pid}; ` +
        `self-reaping superseded orphan pid ${process.pid}\n`,
    )
    releaseAndExit()
  }
}
if (SELFCHECK_INTERVAL_MS > 0) {
  setInterval(selfCheckOwnership, SELFCHECK_INTERVAL_MS).unref?.()
}

const mcp = new Server(
  { name: 'local-ipc', version: PLUGIN_VERSION },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      `You are agent "${AGENT}" on the local-ipc message channel.`,
      '',
      'Send a 1:1 message to another agent with the `send` tool. Delivery is best-effort (at-most-once): a message to an offline peer queues in their inbox and drains on their next launch, but the wake push only lands once the session is in steady-state idle-listening, so a message delivered during that startup window can be missed. Do not use messages for work that must not be lost.',
      '',
      'Incoming messages arrive as <channel source="local-ipc" from="..." ts="...">.',
      '',
      'Use the `list_agents` tool to discover which peers are currently registered.',
      '',
      "This channel is a local filesystem queue — no network, no auth. Sender identity is self-declared by the other session's env, so trust it only as much as you trust the other session itself.",
    ].join('\n'),
  },
)

function recipientInbox(to: string): string {
  if (!isValidAgentName(to)) {
    throw new Error(`invalid recipient name: ${to}`)
  }
  const dir = join(BASE, to, 'inbox')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** OS-reported start time of `pid` in epoch ms, or null if it can't be read. */
function procStartMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
    return parseProcStart(out)
  } catch {
    return null // no such process / ps unavailable
  }
}

function listRegisteredAgents(): Registration[] {
  try {
    const entries = readdirSync(BASE, { withFileTypes: true })
    const out: Registration[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const regPath = join(BASE, e.name, 'registered.json')
      try {
        const raw = readFileSync(regPath, 'utf8')
        const reg = JSON.parse(raw) as Registration
        reg.alive = isPidAlive(reg.pid)
        out.push(reg)
      } catch {
        // No registration file — agent never ran or was cleaned up. Skip.
      }
    }
    return out
  } catch {
    return []
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send',
      description:
        `Send a message to another agent on the local-ipc channel. ` +
        `The recipient session receives it as a <channel source="local-ipc" from="${AGENT}" ...> block on its next turn. ` +
        `If the recipient is offline, messages queue in their inbox and deliver on next launch. ` +
        `Use list_agents first if you're unsure whether the recipient exists.`,
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient agent name (matches the recipient\'s LOCAL_IPC_AGENT_NAME). Lowercase alphanumeric, underscore, or hyphen; 1-32 chars.',
          },
          text: {
            type: 'string',
            description: 'Message body. Plain text.',
          },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'list_agents',
      description:
        'List all agents that have ever registered on this machine (by reading each peer\'s registered.json). Each entry includes name, pid, version, registered_at, and a best-effort `alive` check via signal 0. Use this before send if unsure who the recipient should be.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name
  if (name === 'send') {
    const args = z
      .object({ to: z.string(), text: z.string() })
      .parse(req.params.arguments ?? {})
    if (args.to === AGENT) {
      throw new Error('refusing to send to self')
    }
    const inbox = recipientInbox(args.to)
    const ts = new Date().toISOString()
    const fname = `${ts.replace(/[:.]/g, '-')}-${randomUUID()}.json`
    const payload = { schema_version: SCHEMA.message, from: AGENT, ts, text: args.text }
    writeFileSync(join(inbox, fname), JSON.stringify(payload), { mode: 0o600 })
    return { content: [{ type: 'text', text: `sent to ${args.to}` }] }
  }
  if (name === 'list_agents') {
    const agents = listRegisteredAgents()
    return {
      content: [
        { type: 'text', text: JSON.stringify(agents, null, 2) },
      ],
    }
  }
  throw new Error(`unknown tool: ${name}`)
})

/**
 * Check that we still own this agent's registration (registered.json pid ===
 * process.pid). The inbox follows registration ownership: a newer server for
 * the same agent name overwrites registered.json at startup, which revokes a
 * stale process's right to drain — otherwise the stale watcher races us and
 * messages evaporate into a dead session (2026-06-08 zombie --bg-spare bug).
 * A missing/corrupt file or a dead owner means nobody holds the inbox, so we
 * reclaim it by rewriting our own registration.
 */
function ownsInbox(): boolean {
  let reg: Registration
  try {
    reg = JSON.parse(readFileSync(MY_REGISTRATION, 'utf8')) as Registration
  } catch {
    writeRegistration() // missing or corrupt — reclaim
    return true
  }
  if (reg.pid === process.pid) return true
  if (isPidAlive(reg.pid)) {
    process.stderr.write(
      `local-ipc: inbox for "${AGENT}" is owned by live pid ${reg.pid}, not us (pid ${process.pid}); skipping drain\n`,
    )
    return false
  }
  writeRegistration() // owner is dead — take over
  return true
}

/**
 * Drain the inbox: read every pending message, deliver to Claude, unlink.
 * Sorted by filename (timestamp-prefixed) to preserve order.
 */
function drainInbox(): void {
  if (!ownsInbox()) return
  let files: string[]
  try {
    files = readdirSync(MY_INBOX).filter(f => f.endsWith('.json')).sort()
  } catch {
    return
  }
  for (const f of files) {
    const path = join(MY_INBOX, f)
    let payload: { from?: string; ts?: string; text?: string }
    try {
      payload = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      process.stderr.write(`local-ipc: skipping malformed ${f}: ${err}\n`)
      try { unlinkSync(path) } catch {}
      continue
    }
    mcp
      .notification({
        method: 'notifications/claude/channel',
        params: {
          content: payload.text ?? '',
          meta: {
            from: payload.from ?? 'unknown',
            ts: payload.ts ?? new Date().toISOString(),
          },
        },
      })
      .catch(err =>
        process.stderr.write(`local-ipc: failed to deliver ${f}: ${err}\n`),
      )
    try { unlinkSync(path) } catch {}
  }
}

// Deliver nothing until the client finishes initializing. Pre-init channel
// notifications are dropped by the client (confirmed: a reconnect nudge fired at
// ~116ms was lost), and draining the inbox pre-init would unlink offline messages
// into the void. So the initial drain AND the watch callbacks are gated on
// clientReady: pre-init arrivals are caught by this initial scan, later ones by the
// watches. drainInbox unlinks, but is idempotent.
let clientReady = false
mcp.oninitialized = () => {
  clientReady = true
  drainInbox()
}

const transport = new StdioServerTransport()
await mcp.connect(transport)

// fs.watch on macOS (FSEvents) fires on directory mutations. drainInbox is
// idempotent and cheap; gate on clientReady so we never deliver before the client
// can receive (the initial drain happens in mcp.oninitialized above).
watch(MY_INBOX, { persistent: true }, () => {
  if (clientReady) drainInbox()
})

process.stderr.write(`local-ipc: agent=${AGENT} inbox=${MY_INBOX}\n`)
