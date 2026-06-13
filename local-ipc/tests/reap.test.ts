import { test, expect } from 'bun:test'
import { shouldSelfReap, shouldReapPredecessor, parseProcStart, type Registration } from '../reap'

const REG = (over: Partial<Registration> = {}): Registration => ({
  name: 'momo',
  pid: 1000,
  version: '0.2.3',
  registered_at: '2026-06-13T01:37:24.000Z',
  ...over,
})

const alive = (pids: number[]) => (pid: number) => pids.includes(pid)

// --- (A) periodic self-check: an orphan exits when a different live pid owns registration ---

test('shouldSelfReap: false when no registration exists', () => {
  expect(shouldSelfReap(null, 1000, alive([1000]))).toBe(false)
})

test('shouldSelfReap: false when we still own the registration', () => {
  expect(shouldSelfReap(REG({ pid: 1000 }), 1000, alive([1000]))).toBe(false)
})

test('shouldSelfReap: false when the registered owner is a different but dead pid (we will reclaim, not exit)', () => {
  // owner 2000 is dead → ownsInbox() reclaims; self-reap must NOT fire.
  expect(shouldSelfReap(REG({ pid: 2000 }), 1000, alive([1000]))).toBe(false)
})

test('shouldSelfReap: true when a different live pid owns registration (we are the superseded orphan)', () => {
  expect(shouldSelfReap(REG({ pid: 2000 }), 1000, alive([1000, 2000]))).toBe(true)
})

// --- (B) startup active reap of a live predecessor, guarded against pid reuse ---

const PRED_REGISTERED = '2026-06-13T01:37:24.000Z'
const startMap = (m: Record<number, number | null>) => (pid: number) =>
  pid in m ? m[pid] : null

test('shouldReapPredecessor: false when there is no predecessor registration', () => {
  expect(shouldReapPredecessor(null, 9999, alive([]), startMap({}))).toBe(false)
})

test('shouldReapPredecessor: false when the predecessor record is our own pid', () => {
  const prev = REG({ pid: 9999, registered_at: PRED_REGISTERED })
  expect(shouldReapPredecessor(prev, 9999, alive([9999]), startMap({ 9999: 0 }))).toBe(false)
})

test('shouldReapPredecessor: false when the predecessor pid is already dead', () => {
  const prev = REG({ pid: 2000, registered_at: PRED_REGISTERED })
  expect(shouldReapPredecessor(prev, 9999, alive([]), startMap({ 2000: 0 }))).toBe(false)
})

test('shouldReapPredecessor: false when the live pid start time is unknown (cannot verify identity)', () => {
  const prev = REG({ pid: 2000, registered_at: PRED_REGISTERED })
  // start time unavailable → refuse to kill (could be an unrelated process).
  expect(shouldReapPredecessor(prev, 9999, alive([2000]), startMap({ 2000: null }))).toBe(false)
})

test('shouldReapPredecessor: true for a genuine predecessor (started at/before it registered)', () => {
  const prev = REG({ pid: 2000, registered_at: PRED_REGISTERED })
  const startedBefore = Date.parse(PRED_REGISTERED) - 60_000 // booted a minute before registering
  expect(shouldReapPredecessor(prev, 9999, alive([2000]), startMap({ 2000: startedBefore }))).toBe(true)
})

test('shouldReapPredecessor: false when the live pid started well AFTER the registration (pid reuse)', () => {
  const prev = REG({ pid: 2000, registered_at: PRED_REGISTERED })
  const startedAfter = Date.parse(PRED_REGISTERED) + 10 * 60_000 // a different process reused pid 2000
  expect(shouldReapPredecessor(prev, 9999, alive([2000]), startMap({ 2000: startedAfter }))).toBe(false)
})

test('shouldReapPredecessor: tolerates small clock skew around the registration instant', () => {
  const prev = REG({ pid: 2000, registered_at: PRED_REGISTERED })
  const startedJustAfter = Date.parse(PRED_REGISTERED) + 1_000 // 1s after — within tolerance
  expect(shouldReapPredecessor(prev, 9999, alive([2000]), startMap({ 2000: startedJustAfter }), 5_000)).toBe(true)
})

// --- OS probe parser: `ps -o lstart=` output → epoch ms ---

test('parseProcStart: parses a ps lstart line into epoch ms', () => {
  expect(parseProcStart('Sat Jun 13 10:37:24 2026')).toBe(Date.parse('Sat Jun 13 10:37:24 2026'))
})

test('parseProcStart: trims surrounding whitespace from ps output', () => {
  expect(parseProcStart('  Sat Jun 13 10:37:24 2026   \n')).toBe(Date.parse('Sat Jun 13 10:37:24 2026'))
})

test('parseProcStart: null for empty or unparseable input (dead pid / no such process)', () => {
  expect(parseProcStart('')).toBeNull()
  expect(parseProcStart('   ')).toBeNull()
  expect(parseProcStart('not a date')).toBeNull()
})
