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
