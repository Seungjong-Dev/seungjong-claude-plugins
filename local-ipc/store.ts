import { mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'

/** Root of the coordination store, sibling to per-agent inbox dirs. */
export function storeDir(base: string): string {
  return join(base, '_store')
}

/** Directory for one primitive's records, e.g. `_store/tasks`. */
export function primitiveDir(base: string, primitive: string): string {
  return join(storeDir(base), primitive)
}

/**
 * Atomically write `data` to `<dir>/<filename>`: write to
 * `<dir>/tmp/<filename>.partial`, then `rename()` into place. The tmp dir lives
 * inside the same primitive dir so the rename stays on one filesystem (atomic).
 * Shared by tasks now; events and the message-inbox retrofit later.
 */
export function atomicWrite(dir: string, filename: string, data: string): void {
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  const tmpPath = join(tmp, `${filename}.partial`)
  writeFileSync(tmpPath, data, { mode: 0o600 })
  renameSync(tmpPath, join(dir, filename))
}
