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
