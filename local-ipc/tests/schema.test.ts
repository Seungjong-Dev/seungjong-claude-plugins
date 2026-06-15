import { test, expect } from 'bun:test'
import { SCHEMA, schemaVerdict } from '../schema'

test('SCHEMA declares the message primitive', () => {
  expect(SCHEMA).toEqual({ message: 1 })
})

test('missing version is treated as legacy and read', () => {
  expect(schemaVerdict('message', undefined)).toBe('ok')
})

test('older or equal version is read', () => {
  expect(schemaVerdict('message', 1)).toBe('ok')
  expect(schemaVerdict('message', 0)).toBe('ok')
})

test('newer-than-known version is skipped', () => {
  expect(schemaVerdict('message', 2)).toBe('skip')
})
