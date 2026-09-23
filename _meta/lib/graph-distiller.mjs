/**
 * Graph-related distillation helpers.
 *
 * Privacy contract: never persist query text, answers, or raw session content.
 * Aggregate retrieval signals belong to `alambic feedback --status hit|miss|stale|wrong`.
 * This module intentionally has no query-logging path.
 */

/**
 * @deprecated Use `_meta/alambic feedback --status` for aggregate signals.
 * Kept as a no-op guard so accidental call sites cannot store queries.
 */
export function recordExecutionTrace(_root, _traceData) {
  throw new Error(
    'recordExecutionTrace is disabled: do not persist query text. Use `_meta/alambic feedback --status hit|miss|stale|wrong` (aggregate only).',
  )
}
