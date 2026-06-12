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
import { isValidAgentName } from './names'
import { SCHEMA } from './schema'
import {
  tasksDir, assignTask, listTasks,
  claimTask, completeTask, failTask, cancelTask,
  tasksToNudge, stampNudged, gcTerminalTasks,
} from './tasks'

/** Captured once at boot — used to re-nudge tasks stamped by a prior owner. */
const PROCESS_START_ISO = new Date().toISOString()

const PLUGIN_VERSION = '0.2.0'

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

// If another live process already claims this agent name, it's likely an
// orphan from a previous session (e.g. a stale --bg-spare that inherited our
// env). We still take ownership — last writer wins — and the pid checks in
// ownsInbox()/the signal handlers neutralize the stale process from then on.
try {
  const prev = JSON.parse(readFileSync(MY_REGISTRATION, 'utf8')) as Registration
  if (prev.pid !== process.pid && isPidAlive(prev.pid)) {
    process.stderr.write(
      `local-ipc: agent "${AGENT}" already registered by live pid ${prev.pid}; ` +
        `taking over ownership as pid ${process.pid} (stale process will stop draining)\n`,
    )
  }
} catch {
  // No previous registration (or unreadable) — nothing to warn about.
}
writeRegistration()

// Graceful cleanup — remove our registration so peers immediately see us as
// gone. Non-graceful exits (SIGKILL, crash) will leave the file; next startup
// overwrites it. Only unlink if we still own the registration: a stale
// process (same agent name) dying later must not destroy the current owner's
// file (2026-06-08: momo's registration wiped by a zombie's cleanup).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    try {
      const reg = JSON.parse(readFileSync(MY_REGISTRATION, 'utf8')) as Registration
      if (reg.pid === process.pid) unlinkSync(MY_REGISTRATION)
    } catch {}
    process.exit(0)
  })
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
      `You are agent "${AGENT}" on the local-ipc coordination channel.`,
      '',
      'Two coordination primitives — pick by intent:',
      '- Message (`send`): 1:1, ephemeral. Use when you need a reply / conversation.',
      '- Task (`assign_task`, then `my_tasks` / `claim_task` / `complete_task` / `fail_task` / `cancel_task`): 1:1, durable, tracked to completion. Use when delegating work that must be tracked to done or failed.',
      'Boundary rule: needs a reply → message; needs completion-tracking → task.',
      '',
      'Incoming messages arrive as <channel source="local-ipc" from="..." ts="...">. A task nudge arrives from "tasks" telling you to call `my_tasks`.',
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

type Registration = {
  name: string
  pid: number
  version: string
  registered_at: string
  alive?: boolean
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
    {
      name: 'assign_task',
      description:
        'Create a durable, completion-tracked task for another agent (or yourself). ' +
        'The target is nudged to call my_tasks. Use this when work must be tracked to done/failed; ' +
        'use `send` for conversational messages that just need a reply.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: "Target agent name (their LOCAL_IPC_AGENT_NAME). Offline targets are queued." },
          title: { type: 'string', description: 'Short task title. Max 200 chars.' },
          body: { type: 'string', description: 'Optional detail.' },
          priority: { type: 'number', description: 'Optional; higher sorts first. Default 0.' },
        },
        required: ['target', 'title'],
      },
    },
    {
      name: 'my_tasks',
      description: 'List tasks targeted at you. Defaults to active (open + claimed). Pass `status` to filter.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'claimed', 'done', 'failed', 'cancelled'], description: 'Optional single status filter.' },
        },
      },
    },
    {
      name: 'claim_task',
      description: 'Mark one of your open tasks as claimed (you are working on it).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'complete_task',
      description: 'Mark a claimed task done, with an optional result string.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, result: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'fail_task',
      description: 'Mark a claimed task failed, with an optional error string.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, error: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'cancel_task',
      description: 'Cancel an open or claimed task (producer or target may cancel).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
  if (name === 'assign_task') {
    const a = z
      .object({ target: z.string(), title: z.string(), body: z.string().optional(), priority: z.number().optional() })
      .parse(req.params.arguments ?? {})
    const rec = assignTask(
      BASE,
      { target: a.target, title: a.title, body: a.body, priority: a.priority, createdBy: AGENT },
      new Date().toISOString(),
    )
    return { content: [{ type: 'text', text: `task ${rec.id} created for ${rec.target}` }] }
  }
  if (name === 'my_tasks') {
    const a = z
      .object({ status: z.enum(['open', 'claimed', 'done', 'failed', 'cancelled']).optional() })
      .parse(req.params.arguments ?? {})
    const statuses = a.status ? [a.status] : (['open', 'claimed'] as const)
    const tasks = listTasks(BASE, AGENT, [...statuses])
    return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] }
  }
  if (name === 'claim_task' || name === 'complete_task' || name === 'fail_task' || name === 'cancel_task') {
    const a = z
      .object({ id: z.string(), result: z.string().optional(), error: z.string().optional() })
      .parse(req.params.arguments ?? {})
    const now = new Date().toISOString()
    const rec =
      name === 'claim_task' ? claimTask(BASE, a.id, now)
      : name === 'complete_task' ? completeTask(BASE, a.id, a.result, now)
      : name === 'fail_task' ? failTask(BASE, a.id, a.error, now)
      : cancelTask(BASE, a.id, now)
    return { content: [{ type: 'text', text: `task ${rec.id} -> ${rec.status}` }] }
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

const transport = new StdioServerTransport()
await mcp.connect(transport)

// Deliver anything queued while we were offline, then watch for new files.
drainInbox()

// fs.watch on macOS (FSEvents) fires on directory mutations. Debounce isn't
// needed here — drainInbox is idempotent and cheap.
watch(MY_INBOX, { persistent: true }, () => {
  drainInbox()
})

// --- Task primitive: watch _store/tasks/ and nudge ourselves about open tasks. ---

/** Deliver one coalesced nudge for our open-and-undelivered tasks, then stamp. */
function nudgeTasks(): void {
  if (!ownsInbox()) return // same single-owner gate as inbox drain
  const open = listTasks(BASE, AGENT, ['open'])
  const due = tasksToNudge(open, PROCESS_START_ISO)
  if (due.length === 0) return
  mcp
    .notification({
      method: 'notifications/claude/channel',
      params: {
        content: `📥 You have ${open.length} open task(s). Call \`my_tasks\` to see them.`,
        meta: { from: 'tasks', ts: new Date().toISOString() },
      },
    })
    .catch(err => process.stderr.write(`local-ipc: failed to deliver task nudge: ${err}\n`))
  stampNudged(BASE, due, new Date().toISOString())
}

// Coalesce bursty fs.watch events into one nudge pass.
let nudgeTimer: ReturnType<typeof setTimeout> | null = null
function scheduleNudge(): void {
  if (nudgeTimer) return
  nudgeTimer = setTimeout(() => { nudgeTimer = null; nudgeTasks() }, 150)
}

// Reclaim disk from old terminal tasks, deliver queued nudges, then watch.
mkdirSync(tasksDir(BASE), { recursive: true, mode: 0o700 })
gcTerminalTasks(BASE, Date.now())
nudgeTasks()
watch(tasksDir(BASE), { persistent: true }, () => scheduleNudge())

process.stderr.write(`local-ipc: agent=${AGENT} inbox=${MY_INBOX} tasks=${tasksDir(BASE)}\n`)
