/** Agent-name grammar shared by startup, `send`, and `assign_task`. */
export const NAME_RE = /^[a-z0-9_-]{1,32}$/

/**
 * Names that name internal store dirs or system-written records. Forbidden as
 * agent names so an agent literally named `_store`/`hub`/`tasks` can't collide
 * with the store layout, the server's `created_by:"hub"`, or the nudge sender.
 */
export const RESERVED_NAMES = new Set(['_store', 'tmp', 'hub', 'tasks', 'events'])

export function isValidAgentName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED_NAMES.has(name)
}
