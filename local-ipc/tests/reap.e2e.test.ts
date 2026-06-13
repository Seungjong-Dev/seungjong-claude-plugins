/**
 * End-to-end repro of the duplicate-watcher bug and its fix. Spawns real
 * `server.ts` processes whose stdin stays OPEN (Bun pipe, never ended) to
 * simulate a disconnect→reconnect: the host starts a new server beside the old
 * one without closing the old one's stdin, so the stdin-EOF self-reap can't
 * fire. The control test proves the bug (orphan survives); (A) and (B) each
 * prove one mechanism reaps it.
 */
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const SERVER = join(ROOT, 'server.ts')
const QUIET = { LOCAL_IPC_RENUDGE_MAX: '0' } // no nudge noise; we only care about pids

function spawnServer(agent: string, dir: string, env: Record<string, string>) {
  return Bun.spawn([process.execPath, SERVER], {
    cwd: ROOT,
    stdin: 'pipe', // keep stdin open → no EOF → mimics a reconnect orphan
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, LOCAL_IPC_AGENT_NAME: agent, LOCAL_IPC_DIR: dir, ...QUIET, ...env },
  })
}

function readPid(dir: string, agent: string): number | null {
  try {
    return (JSON.parse(readFileSync(join(dir, agent, 'registered.json'), 'utf8')) as { pid: number }).pid
  } catch {
    return null
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 5000, stepMs = 40): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await Bun.sleep(stepMs)
  }
  return cond()
}

/** Resolve true if the process exits within `ms`, false if it's still running. */
function exitsWithin(p: { exited: Promise<number> }, ms: number): Promise<boolean> {
  return Promise.race([p.exited.then(() => true), Bun.sleep(ms).then(() => false)])
}

test('(control) with both reap mechanisms disabled, the superseded watcher survives — reproduces the bug', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lipc-reap-ctl-'))
  const env = { LOCAL_IPC_SELFCHECK_MS: '0', LOCAL_IPC_REAP_PREDECESSOR: '0' }
  const p1 = spawnServer('reapctl', dir, env)
  expect(await waitUntil(() => readPid(dir, 'reapctl') === p1.pid)).toBe(true)
  const p2 = spawnServer('reapctl', dir, env)
  expect(await waitUntil(() => readPid(dir, 'reapctl') === p2.pid)).toBe(true)

  // Old watcher keeps running: two watchers on one inbox (the reported defect).
  expect(await exitsWithin(p1, 1500)).toBe(false)
  expect(p1.exitCode).toBeNull()

  p1.kill(); p2.kill()
  await Promise.all([p1.exited, p2.exited])
})

test('(A) a superseded watcher self-reaps when a newer live pid owns registration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lipc-reap-a-'))
  // Predecessor-reap OFF so only the periodic self-check can end P1.
  const env = { LOCAL_IPC_SELFCHECK_MS: '150', LOCAL_IPC_REAP_PREDECESSOR: '0' }
  const p1 = spawnServer('reapa', dir, env)
  expect(await waitUntil(() => readPid(dir, 'reapa') === p1.pid)).toBe(true)
  const p2 = spawnServer('reapa', dir, env)
  expect(await waitUntil(() => readPid(dir, 'reapa') === p2.pid)).toBe(true)

  expect(await exitsWithin(p1, 3000)).toBe(true) // P1 self-reaps
  expect(p2.exitCode).toBeNull() // P2 (the live owner) survives
  expect(readPid(dir, 'reapa')).toBe(p2.pid) // P1's exit left P2's registration intact

  p2.kill(); await p2.exited
})

test('(regression) the existing stdin-EOF self-reap still fires and releases registration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lipc-reap-eof-'))
  const p = spawnServer('reapeof', dir, { LOCAL_IPC_SELFCHECK_MS: '0', LOCAL_IPC_REAP_PREDECESSOR: '0' })
  expect(await waitUntil(() => readPid(dir, 'reapeof') === p.pid)).toBe(true)

  p.stdin!.end() // plugin-disable path: parent closes stdin → EOF
  expect(await exitsWithin(p, 3000)).toBe(true)
  expect(await p.exited).toBe(0) // graceful exit code
  expect(readPid(dir, 'reapeof')).toBeNull() // releaseAndExit unlinked its own registration
})

test('(B) a new watcher actively reaps a verifiable live predecessor at startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lipc-reap-b-'))
  // Self-check OFF on both so P1 can only be ended by P2's startup reap.
  const p1 = spawnServer('reapb', dir, { LOCAL_IPC_SELFCHECK_MS: '0' })
  expect(await waitUntil(() => readPid(dir, 'reapb') === p1.pid)).toBe(true)
  const p2 = spawnServer('reapb', dir, { LOCAL_IPC_SELFCHECK_MS: '0', LOCAL_IPC_REAP_GRACE_MS: '300' })

  expect(await exitsWithin(p1, 3000)).toBe(true) // P2 SIGTERM/SIGKILL reaped P1
  expect(p2.exitCode).toBeNull()
  expect(readPid(dir, 'reapb')).toBe(p2.pid) // ownership claimed before reap → registration survived

  p2.kill(); await p2.exited
})
