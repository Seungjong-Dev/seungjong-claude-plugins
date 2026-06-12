import { readdirSync, readFileSync, unlinkSync } from 'fs'
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
