/**
 * Watcher lifecycle reaping decisions.
 *
 * The channel's correctness rests on one invariant: exactly one live watcher
 * per agent. v0.2.1 self-reap only fires on stdin EOF / a termination signal,
 * which a disconnect→reconnect never delivers (the host spawns a fresh
 * server.ts alongside the old one without closing its stdin). The pure
 * decisions below let server.ts restore the invariant from the inside:
 *
 *  - shouldSelfReap        — (A) a superseded orphan exits on its own.
 *  - shouldReapPredecessor — (B) a new server actively kills its predecessor.
 *
 * Both are side-effect free so they can be unit-tested; server.ts injects the
 * real `isAlive`/`procStartMs` probes.
 */

export interface Registration {
  name: string
  pid: number
  version: string
  registered_at: string
  alive?: boolean
}

/**
 * (A) Should THIS watcher reap itself? True only when a *different, live* pid
 * owns the registration — i.e. a newer session took over and we are the stale
 * orphan. A missing record, our own pid, or a dead owner all return false: in
 * those cases nobody newer holds the inbox, so ownsInbox() reclaims it instead.
 */
export function shouldSelfReap(
  reg: Registration | null,
  myPid: number,
  isAlive: (pid: number) => boolean,
): boolean {
  if (!reg) return false
  if (reg.pid === myPid) return false
  return isAlive(reg.pid)
}

/**
 * Parse one line of `ps -o lstart=` output (e.g. "Sat Jun 13 10:37:24 2026")
 * into epoch ms, or null if empty/unparseable (dead pid, no such process).
 * Kept pure so the OS-probe glue in server.ts stays testable.
 */
export function parseProcStart(lstart: string): number | null {
  const trimmed = lstart.trim()
  if (!trimmed) return null
  const ms = Date.parse(trimmed)
  return Number.isNaN(ms) ? null : ms
}

export const DEFAULT_REAP_TOLERANCE_MS = 5_000

/**
 * (B) At startup, should we actively SIGTERM/SIGKILL the predecessor named in
 * `prev`? Only when it is a different, live pid whose OS start time is
 * consistent with having written `registered_at` — a genuine predecessor boots
 * and *then* registers, so its start time is at/before `registered_at` (within
 * tolerance). A pid that started well after the registration is an unrelated
 * process that reused the number; killing it would be friendly fire, so refuse.
 * If the start time can't be read, refuse for the same reason.
 */
export function shouldReapPredecessor(
  prev: Registration | null,
  myPid: number,
  isAlive: (pid: number) => boolean,
  procStartMs: (pid: number) => number | null,
  toleranceMs: number = DEFAULT_REAP_TOLERANCE_MS,
): boolean {
  if (!prev) return false
  if (prev.pid === myPid) return false
  if (!isAlive(prev.pid)) return false
  const start = procStartMs(prev.pid)
  if (start === null) return false
  const registeredAt = Date.parse(prev.registered_at)
  if (Number.isNaN(registeredAt)) return false
  return start <= registeredAt + toleranceMs
}
