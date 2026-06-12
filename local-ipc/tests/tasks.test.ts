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
