# local-ipc Task Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevate the `local-ipc` plugin from a message channel to a local agent coordination substrate by adding a durable, lifecycle-tracked **task** primitive alongside the existing **message** primitive.

**Architecture:** Today `server.ts` is one script that runs all side-effects on import (env check → registration → `mcp.connect`), so its logic can't be unit-tested. We extract pure, dependency-injected modules (`names.ts`, `schema.ts`, `store.ts`, `tasks.ts`) that take a base directory as a parameter and have no import-time side-effects. `server.ts` becomes thin wiring: it registers the new MCP tools, watches `_store/tasks/`, and delivers self-healing nudges. Tasks are durable one-file-per-record under `~/.claude/channels/local-ipc/_store/tasks/<target>__<id>.json` (filename encodes immutable routing so watchers prefix-skip other agents' files and the server can glob by target). The dedup invariant shifts from the inbox's "single owner + unlink" to "`ownsInbox()` gate + `nudged_at` stamp"; because the durable record (not the nudge) is the source of truth, a lost nudge is recoverable — "task visibility is at-least-once, nudge is at-most-once."

**Tech Stack:** Bun 1.3.x (runtime + built-in `bun test`), TypeScript, `@modelcontextprotocol/sdk`, `zod`, Node `fs`/`crypto`.

**Out of scope (P2.5 fast-follow, do NOT implement here):** the `event` primitive (1:N broadcast, per-agent cursors). This plan only ensures the store layout (`_store/<primitive>/`, generic `atomicWrite`, central `SCHEMA`) is forward-compatible so events slot in later without rework.

**Confirmed decisions baked into this plan:** `cancel_task` exists (agent + server reachable, idempotent + `updated_at` last-write-wins); terminal-task GC = 7 days; `assign_task` (not `enqueue_task`); target validated by name **format** only (never by live registration, so offline agents can be queued); reserved names `{_store, tmp, hub, tasks, events}` excluded from agent names; task nudge arrives `from: "tasks"`; `schema_version` retrofit to messages in the same release; central `SCHEMA = {message:1, task:1, event:1}`.

---

## File Structure

- `local-ipc/names.ts` *(new)* — agent-name regex + reserved-name set + `isValidAgentName`. One source of truth used by startup env check, `send` recipient validation, and `assign_task` target validation.
- `local-ipc/schema.ts` *(new)* — central `SCHEMA` version map + `schemaVerdict` reader policy (newer → skip, missing/older → ok).
- `local-ipc/store.ts` *(new)* — store path helpers (`storeDir`, `primitiveDir`) + shared `atomicWrite` (tmp + `rename()`), reused by tasks now / events later / message retrofit.
- `local-ipc/tasks.ts` *(new)* — `TaskRecord` type, CRUD (`assignTask`/`listTasks`/`getTask`), transitions (`claim`/`complete`/`fail`/`cancel`, idempotent + LWW), nudge decision (`tasksToNudge`/`stampNudged`), `gcTerminalTasks`. All take `base` — no import-time side-effects.
- `local-ipc/server.ts` *(modify)* — wire the 6 task MCP tools, route name validation through `names.ts`, add `schema_version` to message payloads, watch `_store/tasks/` with self-healing nudge delivery, run GC on startup.
- `local-ipc/tests/names.test.ts`, `schema.test.ts`, `store.test.ts`, `tasks.test.ts` *(new)* — unit tests against temp dirs.
- `local-ipc/.claude-plugin/plugin.json`, `local-ipc/package.json`, `local-ipc/README.md` *(modify)* — version 0.2.0, graduated description, keywords, docs.

`server.ts` stays unit-test-free by design (it calls `mcp.connect` at import time). All logic lives in the pure modules; `server.ts` is verified by the manual integration smoke test in Task 8.

---

## Task 0: Test infra + shared name validation

**Files:**
- Modify: `local-ipc/package.json` (add `test` script)
- Create: `local-ipc/names.ts`
- Test: `local-ipc/tests/names.test.ts`

- [ ] **Step 1: Add the test script**

In `local-ipc/package.json`, add a `test` script next to `start`:

```json
  "scripts": {
    "start": "bun install --no-summary && bun server.ts",
    "test": "bun test"
  },
```

- [ ] **Step 2: Write the failing test**

Create `local-ipc/tests/names.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { isValidAgentName, RESERVED_NAMES } from '../names'

test('accepts normal agent names', () => {
  expect(isValidAgentName('momo')).toBe(true)
  expect(isValidAgentName('agent-a')).toBe(true)
  expect(isValidAgentName('worker_1')).toBe(true)
})

test('rejects reserved names', () => {
  for (const n of ['_store', 'tmp', 'hub', 'tasks', 'events']) {
    expect(isValidAgentName(n)).toBe(false)
    expect(RESERVED_NAMES.has(n)).toBe(true)
  }
})

test('rejects malformed names', () => {
  expect(isValidAgentName('')).toBe(false)
  expect(isValidAgentName('UPPER')).toBe(false)
  expect(isValidAgentName('has space')).toBe(false)
  expect(isValidAgentName('a'.repeat(33))).toBe(false)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd local-ipc && bun test tests/names.test.ts`
Expected: FAIL — cannot resolve module `../names`.

- [ ] **Step 4: Write minimal implementation**

Create `local-ipc/names.ts`:

```ts
/** Agent-name grammar shared by startup, `send`, and `assign_task`. */
export const NAME_RE = /^[a-z0-9_-]{1,32}$/

/**
 * Names that name internal store dirs or system-written records. Forbidden as
 * agent names so an agent literally named `_store`/`hub`/`tasks` can't collide
 * with the store layout, the server's `created_by:"hub"`, or the nudge sender.
 */
export const RESERVED_NAMES = new Set(['_store', 'tmp', 'hub', 'tasks', 'events'])

export function isValidAgentName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED_NAMES.has(name)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd local-ipc && bun test tests/names.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add local-ipc/package.json local-ipc/names.ts local-ipc/tests/names.test.ts
git commit -m "test: add bun test infra + shared agent-name validation with reserved names"
```

---

## Task 1: Central schema versioning + reader policy

**Files:**
- Create: `local-ipc/schema.ts`
- Test: `local-ipc/tests/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `local-ipc/tests/schema.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { SCHEMA, schemaVerdict } from '../schema'

test('SCHEMA declares all three primitives', () => {
  expect(SCHEMA).toEqual({ message: 1, task: 1, event: 1 })
})

test('missing version is treated as legacy and read', () => {
  expect(schemaVerdict('task', undefined)).toBe('ok')
})

test('older or equal version is read', () => {
  expect(schemaVerdict('task', 1)).toBe('ok')
  expect(schemaVerdict('message', 0)).toBe('ok')
})

test('newer-than-known version is skipped', () => {
  expect(schemaVerdict('task', 2)).toBe('skip')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd local-ipc && bun test tests/schema.test.ts`
Expected: FAIL — cannot resolve `../schema`.

- [ ] **Step 3: Write minimal implementation**

Create `local-ipc/schema.ts`:

```ts
/** Record schema versions per primitive. Bump on any breaking record change. */
export const SCHEMA = { message: 1, task: 1, event: 1 } as const
export type Primitive = keyof typeof SCHEMA

/**
 * Reader policy for versioned records:
 *  - 'ok'   : known or older version (best-effort for older) → read it
 *  - 'skip' : newer than we understand → skip + log, never crash
 * A missing/undefined version is legacy (0) → 'ok'.
 */
export function schemaVerdict(primitive: Primitive, version: number | undefined): 'ok' | 'skip' {
  return (version ?? 0) > SCHEMA[primitive] ? 'skip' : 'ok'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd local-ipc && bun test tests/schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add local-ipc/schema.ts local-ipc/tests/schema.test.ts
git commit -m "feat: central SCHEMA version map + reader policy"
```

---

## Task 2: Store paths + atomic write helper

**Files:**
- Create: `local-ipc/store.ts`
- Test: `local-ipc/tests/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `local-ipc/tests/store.test.ts`:

```ts
import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { storeDir, primitiveDir, atomicWrite } from '../store'

let base: string
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'lipc-store-')) })

test('path helpers compose the documented layout', () => {
  expect(storeDir(base)).toBe(join(base, '_store'))
  expect(primitiveDir(base, 'tasks')).toBe(join(base, '_store', 'tasks'))
})

test('atomicWrite creates the dir and writes the final file', () => {
  const dir = primitiveDir(base, 'tasks')
  atomicWrite(dir, 'a__1.json', '{"ok":true}')
  expect(JSON.parse(readFileSync(join(dir, 'a__1.json'), 'utf8'))).toEqual({ ok: true })
})

test('atomicWrite leaves no partial file behind', () => {
  const dir = primitiveDir(base, 'tasks')
  atomicWrite(dir, 'a__1.json', 'x')
  const tmp = join(dir, 'tmp')
  expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd local-ipc && bun test tests/store.test.ts`
Expected: FAIL — cannot resolve `../store`.

- [ ] **Step 3: Write minimal implementation**

Create `local-ipc/store.ts`:

```ts
import { mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'

/** Root of the coordination store, sibling to per-agent inbox dirs. */
export function storeDir(base: string): string {
  return join(base, '_store')
}

/** Directory for one primitive's records, e.g. `_store/tasks`. */
export function primitiveDir(base: string, primitive: string): string {
  return join(storeDir(base), primitive)
}

/**
 * Atomically write `data` to `<dir>/<filename>`: write to
 * `<dir>/tmp/<filename>.partial`, then `rename()` into place. The tmp dir lives
 * inside the same primitive dir so the rename stays on one filesystem (atomic).
 * Shared by tasks now; events and the message-inbox retrofit later.
 */
export function atomicWrite(dir: string, filename: string, data: string): void {
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  const tmpPath = join(tmp, `${filename}.partial`)
  writeFileSync(tmpPath, data, { mode: 0o600 })
  renameSync(tmpPath, join(dir, filename))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd local-ipc && bun test tests/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add local-ipc/store.ts local-ipc/tests/store.test.ts
git commit -m "feat: store path helpers + shared atomic write (tmp + rename)"
```

---

## Task 3: Task record + create/list/get

**Files:**
- Create: `local-ipc/tasks.ts`
- Test: `local-ipc/tests/tasks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `local-ipc/tests/tasks.test.ts`:

```ts
import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assignTask, listTasks, getTask, tasksDir } from '../tasks'

let base: string
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'lipc-tasks-')) })
const T0 = '2026-06-12T00:00:00.000Z'

test('assignTask writes a target__id.json record with schema + open status', () => {
  const rec = assignTask(base, { target: 'momo', title: 'do x', createdBy: 'main' }, T0)
  expect(rec.status).toBe('open')
  expect(rec.schema_version).toBe(1)
  expect(rec.nudged_at).toBeNull()
  expect(rec.created_by).toBe('main')
  const files = readdirSync(tasksDir(base)).filter(f => f.endsWith('.json'))
  expect(files).toEqual([`momo__${rec.id}.json`])
})

test('assignTask rejects invalid/reserved targets', () => {
  expect(() => assignTask(base, { target: 'hub', title: 't', createdBy: 'main' }, T0)).toThrow()
  expect(() => assignTask(base, { target: 'UP', title: 't', createdBy: 'main' }, T0)).toThrow()
})

test('listTasks scopes by target and skips other agents by filename prefix', () => {
  assignTask(base, { target: 'momo', title: 'a', createdBy: 'main' }, T0)
  assignTask(base, { target: 'main', title: 'b', createdBy: 'momo' }, T0)
  const mine = listTasks(base, 'momo')
  expect(mine.map(t => t.title)).toEqual(['a'])
})

test('listTasks filters by status; getTask finds by id across targets', () => {
  const r = assignTask(base, { target: 'momo', title: 'a', createdBy: 'main' }, T0)
  expect(listTasks(base, 'momo', ['open']).length).toBe(1)
  expect(listTasks(base, 'momo', ['done']).length).toBe(0)
  expect(getTask(base, r.id)?.id).toBe(r.id)
  expect(getTask(base, 'nope')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd local-ipc && bun test tests/tasks.test.ts`
Expected: FAIL — cannot resolve `../tasks`.

- [ ] **Step 3: Write minimal implementation**

Create `local-ipc/tasks.ts`:

```ts
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { primitiveDir, atomicWrite } from './store'
import { SCHEMA, schemaVerdict } from './schema'
import { isValidAgentName } from './names'

export type TaskStatus = 'open' | 'claimed' | 'done' | 'failed' | 'cancelled'
export const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'failed', 'cancelled'])

export interface TaskRecord {
  schema_version: number
  id: string
  target: string
  title: string
  body?: string
  status: TaskStatus
  priority: number
  created_by: string
  nudged_at: string | null
  result?: string
  error?: string
  created_at: string
  updated_at: string
}

export function tasksDir(base: string): string {
  return primitiveDir(base, 'tasks')
}

/** Filename encodes immutable routing (target) → cheap prefix-skip + server glob. */
function taskFilename(target: string, id: string): string {
  return `${target}__${id}.json`
}

function readTaskFile(dir: string, file: string): TaskRecord | null {
  try {
    const rec = JSON.parse(readFileSync(join(dir, file), 'utf8')) as TaskRecord
    if (schemaVerdict('task', rec.schema_version) === 'skip') {
      process.stderr.write(`local-ipc: skipping task ${file} (newer schema ${rec.schema_version})\n`)
      return null
    }
    return rec
  } catch (err) {
    process.stderr.write(`local-ipc: skipping malformed task ${file}: ${err}\n`)
    return null
  }
}

/** Locate a task file by id regardless of target (suffix match). */
function findTaskFile(dir: string, id: string): string | null {
  let files: string[]
  try { files = readdirSync(dir) } catch { return null }
  const suffix = `__${id}.json`
  return files.find(f => f.endsWith(suffix)) ?? null
}

export interface AssignInput {
  target: string
  title: string
  body?: string
  priority?: number
  createdBy: string
}

export function assignTask(base: string, input: AssignInput, nowIso: string): TaskRecord {
  if (!isValidAgentName(input.target)) {
    throw new Error(`invalid target name: ${input.target}`)
  }
  if (!input.title || input.title.length > 200) {
    throw new Error('title required, max 200 chars')
  }
  const rec: TaskRecord = {
    schema_version: SCHEMA.task,
    id: randomUUID(),
    target: input.target,
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    status: 'open',
    priority: input.priority ?? 0,
    created_by: input.createdBy,
    nudged_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  }
  atomicWrite(tasksDir(base), taskFilename(rec.target, rec.id), JSON.stringify(rec, null, 2))
  return rec
}

/** List tasks targeted at `agent`, skipping other agents' files by name prefix. */
export function listTasks(base: string, agent: string, statuses?: TaskStatus[]): TaskRecord[] {
  const dir = tasksDir(base)
  let files: string[]
  try { files = readdirSync(dir) } catch { return [] }
  const prefix = `${agent}__`
  const out: TaskRecord[] = []
  for (const f of files) {
    if (!f.endsWith('.json') || !f.startsWith(prefix)) continue
    const rec = readTaskFile(dir, f)
    if (!rec) continue
    if (statuses && !statuses.includes(rec.status)) continue
    out.push(rec)
  }
  out.sort((a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at))
  return out
}

export function getTask(base: string, id: string): TaskRecord | null {
  const dir = tasksDir(base)
  const file = findTaskFile(dir, id)
  return file ? readTaskFile(dir, file) : null
}

// --- internal helpers re-exported for sibling functions in later tasks ---
export const _internal = { taskFilename, readTaskFile, findTaskFile }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd local-ipc && bun test tests/tasks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add local-ipc/tasks.ts local-ipc/tests/tasks.test.ts
git commit -m "feat: task record + assign/list/get with target-encoded filenames"
```

---

## Task 4: Lifecycle transitions (claim/complete/fail/cancel)

**Files:**
- Modify: `local-ipc/tasks.ts` (add transitions)
- Test: `local-ipc/tests/tasks.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `local-ipc/tests/tasks.test.ts`:

```ts
import { claimTask, completeTask, failTask, cancelTask, transitionTask } from '../tasks'

test('happy path open -> claimed -> done with result', () => {
  const r = assignTask(base, { target: 'momo', title: 'a', createdBy: 'main' }, T0)
  expect(claimTask(base, r.id, T0).status).toBe('claimed')
  const done = completeTask(base, r.id, 'shipped', T0)
  expect(done.status).toBe('done')
  expect(done.result).toBe('shipped')
})

test('fail and cancel reach terminal states', () => {
  const a = assignTask(base, { target: 'momo', title: 'a', createdBy: 'main' }, T0)
  claimTask(base, a.id, T0)
  expect(failTask(base, a.id, 'boom', T0).status).toBe('failed')
  const b = assignTask(base, { target: 'momo', title: 'b', createdBy: 'main' }, T0)
  expect(cancelTask(base, b.id, T0).status).toBe('cancelled') // open -> cancelled allowed
})

test('transition into the same status is an idempotent no-op', () => {
  const r = assignTask(base, { target: 'momo', title: 'a', createdBy: 'main' }, T0)
  claimTask(base, r.id, T0)
  completeTask(base, r.id, 'x', T0)
  expect(completeTask(base, r.id, 'ignored', '2026-06-12T01:00:00.000Z').result).toBe('x')
})

test('invalid transition rejects with current state', () => {
  const r = assignTask(base, { target: 'momo', title: 'a', createdBy: 'main' }, T0)
  expect(() => completeTask(base, r.id, 'x', T0)).toThrow(/open -> done/) // not claimed yet
})

test('transition on missing task throws not found', () => {
  expect(() => claimTask(base, 'nope', T0)).toThrow(/not found/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd local-ipc && bun test tests/tasks.test.ts`
Expected: FAIL — `claimTask`/`completeTask`/`failTask`/`cancelTask`/`transitionTask` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `local-ipc/tasks.ts`:

```ts
const ALLOWED_FROM: Record<Exclude<TaskStatus, 'open'>, TaskStatus[]> = {
  claimed: ['open'],
  done: ['claimed'],
  failed: ['claimed'],
  cancelled: ['open', 'claimed'],
}

/**
 * Move a task to `to`. Idempotent: already-in-`to` returns the current record
 * without rewriting. Invalid transitions throw with the current state. No
 * locking — writes are rename-atomic and concurrent edits degrade to
 * last-write-wins on `updated_at` (acceptable; mirrors server-side card triage).
 */
export function transitionTask(
  base: string,
  id: string,
  to: Exclude<TaskStatus, 'open'>,
  patch: { result?: string; error?: string },
  nowIso: string,
): TaskRecord {
  const dir = tasksDir(base)
  const file = _internal.findTaskFile(dir, id)
  if (!file) throw new Error(`task not found: ${id}`)
  const rec = _internal.readTaskFile(dir, file)
  if (!rec) throw new Error(`task unreadable: ${id}`)
  if (rec.status === to) return rec // idempotent no-op
  if (!ALLOWED_FROM[to].includes(rec.status)) {
    throw new Error(`invalid transition ${rec.status} -> ${to} for task ${id}`)
  }
  const next: TaskRecord = {
    ...rec,
    status: to,
    updated_at: nowIso,
    ...(patch.result !== undefined ? { result: patch.result } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
  }
  atomicWrite(dir, file, JSON.stringify(next, null, 2))
  return next
}

export const claimTask = (base: string, id: string, now: string): TaskRecord =>
  transitionTask(base, id, 'claimed', {}, now)
export const completeTask = (base: string, id: string, result: string | undefined, now: string): TaskRecord =>
  transitionTask(base, id, 'done', { result }, now)
export const failTask = (base: string, id: string, error: string | undefined, now: string): TaskRecord =>
  transitionTask(base, id, 'failed', { error }, now)
export const cancelTask = (base: string, id: string, now: string): TaskRecord =>
  transitionTask(base, id, 'cancelled', {}, now)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd local-ipc && bun test tests/tasks.test.ts`
Expected: PASS (all tasks.test.ts tests).

- [ ] **Step 5: Commit**

```bash
git add local-ipc/tasks.ts local-ipc/tests/tasks.test.ts
git commit -m "feat: task lifecycle transitions (claim/complete/fail/cancel, idempotent + LWW)"
```

---

## Task 5: Self-healing nudge decision + stamp

**Files:**
- Modify: `local-ipc/tasks.ts` (add `tasksToNudge`, `stampNudged`)
- Test: `local-ipc/tests/tasks.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `local-ipc/tests/tasks.test.ts`:

```ts
import { tasksToNudge, stampNudged } from '../tasks'

const START = '2026-06-12T12:00:00.000Z'

test('tasksToNudge picks open tasks never nudged', () => {
  const open = { status: 'open', nudged_at: null } as any
  expect(tasksToNudge([open], START).length).toBe(1)
})

test('tasksToNudge skips open tasks nudged after this process started', () => {
  const fresh = { status: 'open', nudged_at: '2026-06-12T12:30:00.000Z' } as any
  expect(tasksToNudge([fresh], START).length).toBe(0)
})

test('tasksToNudge re-nudges open tasks stamped before this process (zombie heal)', () => {
  const stale = { status: 'open', nudged_at: '2026-06-12T11:00:00.000Z' } as any
  expect(tasksToNudge([stale], START).length).toBe(1)
})

test('tasksToNudge ignores non-open tasks', () => {
  const claimed = { status: 'claimed', nudged_at: null } as any
  expect(tasksToNudge([claimed], START).length).toBe(0)
})

test('stampNudged writes nudged_at only on still-open records', () => {
  const r = assignTask(base, { target: 'momo', title: 'a', createdBy: 'main' }, T0)
  stampNudged(base, [r], START)
  expect(getTask(base, r.id)?.nudged_at).toBe(START)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd local-ipc && bun test tests/tasks.test.ts`
Expected: FAIL — `tasksToNudge`/`stampNudged` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `local-ipc/tasks.ts`:

```ts
/**
 * Which open tasks for an agent still need a nudge. A task needs nudging if it
 * was never nudged, OR last nudged before `processStartIso` — meaning a previous
 * or zombie owner stamped it but THIS session never delivered it. Self-heals lost
 * nudges (ownership flips, fs.watch misses) without flooding. ISO-8601 UTC (`Z`)
 * strings compare lexicographically === chronologically.
 */
export function tasksToNudge(records: TaskRecord[], processStartIso: string): TaskRecord[] {
  return records.filter(
    r => r.status === 'open' && (r.nudged_at === null || r.nudged_at < processStartIso),
  )
}

/** Stamp `nudged_at` on records that are still open (re-read to avoid clobbering). */
export function stampNudged(base: string, recs: TaskRecord[], nowIso: string): void {
  const dir = tasksDir(base)
  for (const rec of recs) {
    const file = _internal.taskFilename(rec.target, rec.id)
    const fresh = _internal.readTaskFile(dir, file)
    if (!fresh || fresh.status !== 'open') continue
    atomicWrite(dir, file, JSON.stringify({ ...fresh, nudged_at: nowIso }, null, 2))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd local-ipc && bun test tests/tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local-ipc/tasks.ts local-ipc/tests/tasks.test.ts
git commit -m "feat: self-healing nudge decision (re-nudge pre-start stamps) + stamp"
```

---

## Task 6: Terminal-task GC (7-day retention)

**Files:**
- Modify: `local-ipc/tasks.ts` (add `gcTerminalTasks`)
- Test: `local-ipc/tests/tasks.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `local-ipc/tests/tasks.test.ts`:

```ts
import { gcTerminalTasks } from '../tasks'

const DAY = 24 * 60 * 60 * 1000

test('gcTerminalTasks deletes terminal tasks older than the TTL', () => {
  const r = assignTask(base, { target: 'momo', title: 'old', createdBy: 'main' }, T0)
  claimTask(base, r.id, T0)
  completeTask(base, r.id, 'x', '2026-06-01T00:00:00.000Z') // updated 11 days before "now"
  const now = Date.parse('2026-06-12T00:00:00.000Z')
  expect(gcTerminalTasks(base, now, 7 * DAY)).toBe(1)
  expect(getTask(base, r.id)).toBeNull()
})

test('gcTerminalTasks keeps recent terminal and all open tasks', () => {
  const open = assignTask(base, { target: 'momo', title: 'open', createdBy: 'main' }, T0)
  const recent = assignTask(base, { target: 'momo', title: 'recent', createdBy: 'main' }, T0)
  claimTask(base, recent.id, T0)
  completeTask(base, recent.id, 'x', '2026-06-11T00:00:00.000Z') // 1 day old
  const now = Date.parse('2026-06-12T00:00:00.000Z')
  expect(gcTerminalTasks(base, now, 7 * DAY)).toBe(0)
  expect(getTask(base, open.id)).not.toBeNull()
  expect(getTask(base, recent.id)).not.toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd local-ipc && bun test tests/tasks.test.ts`
Expected: FAIL — `gcTerminalTasks` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `local-ipc/tasks.ts`:

```ts
import { unlinkSync } from 'fs'

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Delete terminal tasks (done/failed/cancelled) whose `updated_at` is older than
 * `ttlMs`. Open/claimed tasks are never collected. Returns the count removed.
 */
export function gcTerminalTasks(base: string, nowMs: number, ttlMs: number = DEFAULT_TTL_MS): number {
  const dir = tasksDir(base)
  let files: string[]
  try { files = readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const rec = _internal.readTaskFile(dir, f)
    if (!rec || !TERMINAL.has(rec.status)) continue
    if (nowMs - Date.parse(rec.updated_at) > ttlMs) {
      try { unlinkSync(join(dir, f)); removed++ } catch {}
    }
  }
  return removed
}
```

Note: move the `import { unlinkSync }` up into the existing `fs` import line at the top of `tasks.ts` (`import { readdirSync, readFileSync, unlinkSync } from 'fs'`) rather than a second import statement — shown separately here only to mark what this task adds.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd local-ipc && bun test tests/tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd local-ipc && bun test`
Expected: PASS — all of names/schema/store/tasks tests green.

- [ ] **Step 6: Commit**

```bash
git add local-ipc/tasks.ts local-ipc/tests/tasks.test.ts
git commit -m "feat: 7-day GC for terminal tasks"
```

---

## Task 7: Wire MCP task tools + route validation + message schema_version

**Files:**
- Modify: `local-ipc/server.ts`

This task has no unit test (server.ts connects at import). It is verified by `bun server.ts` starting cleanly here and by the integration smoke test in Task 8.

- [ ] **Step 1: Add imports and process-start timestamp**

In `local-ipc/server.ts`, after the existing `import` block (after line 35, the `randomUUID` import), add:

```ts
import { isValidAgentName } from './names'
import { SCHEMA } from './schema'
import {
  tasksDir, assignTask, listTasks,
  claimTask, completeTask, failTask, cancelTask,
  tasksToNudge, stampNudged, gcTerminalTasks,
} from './tasks'

/** Captured once at boot — used to re-nudge tasks stamped by a prior owner. */
const PROCESS_START_ISO = new Date().toISOString()
```

- [ ] **Step 2: Route the startup env check through shared validation**

Replace the AGENT guard (currently `if (!AGENT || !/^[a-z0-9_-]{1,32}$/.test(AGENT)) {`) with:

```ts
if (!AGENT || !isValidAgentName(AGENT)) {
  process.stderr.write(
    `local-ipc: LOCAL_IPC_AGENT_NAME required (lowercase alphanumeric/_/-, 1-32 chars, not a reserved name). Set in launcher.\n`,
  )
  process.exit(1)
}
```

- [ ] **Step 3: Route recipient validation + add message schema_version**

In `recipientInbox`, replace `if (!/^[a-z0-9_-]{1,32}$/.test(to)) {` with `if (!isValidAgentName(to)) {`.

In the `send` handler, change the payload line from
`const payload = { from: AGENT, ts, text: args.text }` to:

```ts
    const payload = { schema_version: SCHEMA.message, from: AGENT, ts, text: args.text }
```

(The `drainInbox` reader already ignores unknown fields and reads `payload.text`, so it stays best-effort backward/forward compatible — no reader change needed.)

- [ ] **Step 4: Register the six task tools**

In the `ListToolsRequestSchema` handler, add these entries to the `tools` array (after the `list_agents` entry):

```ts
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
```

- [ ] **Step 5: Handle the six task tool calls**

In the `CallToolRequestSchema` handler, add these branches **before** the final `throw new Error(\`unknown tool: ${name}\`)`:

```ts
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
```

- [ ] **Step 6: Wire task watch + self-healing nudge + startup GC**

Replace the tail of `server.ts` (from `// Deliver anything queued while we were offline...` through the inbox `watch(...)` block and the final stderr line) with:

```ts
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
```

- [ ] **Step 7: Verify the server starts and type-checks**

Run:
```bash
cd local-ipc && LOCAL_IPC_AGENT_NAME=plan-smoke timeout 2 bun server.ts; echo "exit=$?"
```
Expected: stderr shows `local-ipc: agent=plan-smoke inbox=... tasks=...` and the process runs until the 2s timeout (`exit=124`). No `SyntaxError`/`TypeError`/unresolved-import output.

- [ ] **Step 8: Run the unit suite (regression)**

Run: `cd local-ipc && bun test`
Expected: PASS — modules unaffected by wiring.

- [ ] **Step 9: Commit**

```bash
git add local-ipc/server.ts
git commit -m "feat: wire task MCP tools, _store/tasks watch with self-healing nudge, startup GC"
```

---

## Task 8: Graduate identity (instructions, plugin.json, docs) + integration smoke test

**Files:**
- Modify: `local-ipc/server.ts` (instructions block + `PLUGIN_VERSION`)
- Modify: `local-ipc/.claude-plugin/plugin.json`
- Modify: `local-ipc/package.json`
- Modify: `local-ipc/README.md`

- [ ] **Step 1: Bump PLUGIN_VERSION**

In `local-ipc/server.ts`, change `const PLUGIN_VERSION = '0.1.1'` to:

```ts
const PLUGIN_VERSION = '0.2.0'
```

- [ ] **Step 2: Update the MCP instructions block with the primitive boundary rule**

Replace the `instructions:` array (currently lines ~110-118) with:

```ts
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
```

- [ ] **Step 3: Graduate plugin.json**

Replace the contents of `local-ipc/.claude-plugin/plugin.json` with:

```json
{
  "name": "local-ipc",
  "description": "Local agent coordination for Claude Code — co-located Claude Code sessions exchange directed messages and durable, completion-tracked tasks via a filesystem queue. Each session is identified by the LOCAL_IPC_AGENT_NAME env var set by its launcher.",
  "version": "0.2.0",
  "keywords": ["ipc", "channel", "multi-agent", "coordination", "task", "orchestration", "agent", "mcp"]
}
```

(Name stays `local-ipc` — renaming would break `local-ipc@seungjong-claude-plugins` references in installed settings and launchers.)

- [ ] **Step 4: Bump package.json version**

In `local-ipc/package.json`, change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 5: Document the task primitive in README**

In `local-ipc/README.md`, after the "Usage from Claude" section, add:

```markdown
## Tasks (durable delegation)

Beyond ephemeral messages, agents can delegate **tasks** — durable records tracked to completion. Use a message when you need a reply; use a task when work must be tracked to done/failed.

- **Create**: `assign_task { target, title, body?, priority? }` — writes a durable record for `target` (offline targets are queued and delivered on their next launch).
- **Receive**: the target is nudged (`from="tasks"`) to call `my_tasks`, which lists tasks where it is the target (defaults to open + claimed).
- **Lifecycle**: `claim_task { id }` (open → claimed) → `complete_task { id, result? }` (→ done) or `fail_task { id, error? }` (→ failed). `cancel_task { id }` cancels an open/claimed task. Transitions are idempotent.

Records live at `~/.claude/channels/local-ipc/_store/tasks/<target>__<id>.json` (`schema_version: 1`); terminal tasks (done/failed/cancelled) are garbage-collected after 7 days. Writes are atomic (tmp + `rename()`). Delivery reuses the same single-owner (`ownsInbox`) gate as the message inbox, so a zombie same-name session can't steal nudges; because the record is the source of truth, a missed nudge is recovered on the next launch or `my_tasks` call.
```

- [ ] **Step 6: Run the full unit suite**

Run: `cd local-ipc && bun test`
Expected: PASS — all green.

- [ ] **Step 7: Integration smoke test (two real sessions, manual)**

This validates end-to-end delivery the unit tests can't (real `notifications/claude/channel`). Run two real Claude Code sessions with the plugin enabled and distinct `LOCAL_IPC_AGENT_NAME`s (e.g. `main` and `momo`), then:

1. From `main`: call `assign_task { target: "momo", title: "ping from plan" }`.
2. In `momo`: confirm a `<channel source="local-ipc" from="tasks" ...>` nudge appears ("📥 You have 1 open task(s)…").
3. In `momo`: call `my_tasks` → see the open task; `claim_task { id }`; `complete_task { id, result: "ok" }`.
4. Inspect the record: `cat ~/.claude/channels/local-ipc/_store/tasks/momo__*.json` → `status: "done"`, `result: "ok"`, `nudged_at` set.
5. Offline-delivery check: with `momo` closed, from `main` call `assign_task { target: "momo", title: "offline test" }`; relaunch `momo`; confirm the nudge arrives on startup.

Record the result of each step in the PR description. (No automated assertion — this is the human checkpoint.)

- [ ] **Step 8: Commit**

```bash
git add local-ipc/server.ts local-ipc/.claude-plugin/plugin.json local-ipc/package.json local-ipc/README.md
git commit -m "feat: graduate local-ipc to coordination substrate (v0.2.0) — instructions, manifest, docs"
```

---

## Self-Review

**Spec coverage** (against `2026-06-12-agent-task-queue-card-dashboard-design.md` §4 and the confirmed decisions):

- §4.1 task record + `schema` versioning → Task 3 (record + `schema_version`), Task 1 (central SCHEMA). ✅
- §4.1 atomic write (tmp + rename) → Task 2 (`atomicWrite`). ✅
- §4.2 tools `assign_task`/`my_tasks`/`claim`/`complete`/`fail` + decided `cancel_task` → Tasks 3–4 (logic), Task 7 (MCP wiring). ✅
- §4.3 plugin-owned delivery: watch `_store/tasks/`, `ownsInbox()` gate, coalesced nudge, `nudged_at` stamp, offline→launch scan → Task 5 (decision/stamp), Task 7 (watch + nudge + startup `nudgeTasks`). ✅
- "task visibility at-least-once / nudge at-most-once" + self-healing re-nudge of pre-start stamps → Task 5 (`tasksToNudge`). ✅
- §7 target validated by format not registration; reserved names; idempotent transitions; malformed records skipped → Task 0 (names), Task 3 (`assignTask` validation, `readTaskFile` skip), Task 4 (idempotent transitions). ✅
- Confirmed: 7-day GC → Task 6. ✅
- Confirmed: filename target-encoding (`<target>__<id>.json`, prefix-skip) → Task 3. ✅
- §5 generic `_store/<primitive>/` layout + pluggable delivery so event (P2.5) slots in → Task 2 (`primitiveDir`), delivery state kept on-record for tasks only (events will use per-agent cursors, not built here). ✅
- message `schema_version` retrofit, same release → Task 7 Step 3. ✅
- Q5: 0.2.0, graduated description, instructions boundary rule → Task 8. ✅

**Event (P2.5) forward-compat confirmed not implemented here**, only enabled: `primitiveDir`/`atomicWrite` are primitive-generic; `SCHEMA.event` reserved; `events` is a reserved agent name. Per-agent event cursors are intentionally absent (would be built in the P2.5 plan).

**Placeholder scan:** no TBD/TODO/"handle edge cases" — every code step shows full code; every run step shows the command + expected output.

**Type consistency:** `TaskRecord` fields (`schema_version`, `nudged_at`, `updated_at`, `target`, `created_by`) are identical across Tasks 3–8. Function names are stable: `assignTask`, `listTasks`, `getTask`, `transitionTask`, `claimTask`, `completeTask`, `failTask`, `cancelTask`, `tasksToNudge`, `stampNudged`, `gcTerminalTasks`, `tasksDir`, `atomicWrite`, `primitiveDir`, `storeDir`, `isValidAgentName`, `SCHEMA`, `schemaVerdict`. Internal helpers (`taskFilename`, `readTaskFile`, `findTaskFile`) are reached via the `_internal` re-export in later same-file functions.

---

## Execution Handoff

(Filled in by the writer after saving — see chat.)
