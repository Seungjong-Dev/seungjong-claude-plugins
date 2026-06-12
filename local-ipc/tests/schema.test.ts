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
