/** Record schema versions per primitive. Bump on any breaking record change. */
export const SCHEMA = { message: 1 } as const
export type Primitive = keyof typeof SCHEMA

/**
 * Reader policy for versioned records:
 *  - 'ok'   : known or older version (best-effort for older) → read it
 *  - 'skip' : newer than we understand → skip + log, never crash
 * A missing/undefined version is legacy (0) → 'ok'.
 */
export function schemaVerdict(primitive: Primitive, version: number | undefined): 'ok' | 'skip' {
  return (version ?? 0) > SCHEMA[primitive] ? 'skip' : 'ok'
}
