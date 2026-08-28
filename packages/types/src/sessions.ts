/** Unified Session lifecycle statuses, mirrored by the sessions table's
 * cached_status check constraint. Derive UI option lists, board columns, and
 * validation from this array rather than re-declaring the literals. */
export const SESSION_STATUSES = [
  'active',
  'needs_input',
  'blocked',
  'ready',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export function getSessionStatusLabel(status: SessionStatus | string): string {
  return status.replace('_', ' ');
}
