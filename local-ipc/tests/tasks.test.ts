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
