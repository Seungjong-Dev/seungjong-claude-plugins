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
