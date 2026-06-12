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
