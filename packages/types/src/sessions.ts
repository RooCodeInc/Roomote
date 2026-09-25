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

/** Semantic status judgment kept separate from the deterministic lifecycle. */
export const SESSION_STATUS_JUDGMENT_OUTCOMES = [
  'open',
  'done',
  'blocked',
  'needs_input',
  'unclear',
] as const;

export type SessionStatusJudgmentOutcome =
  (typeof SESSION_STATUS_JUDGMENT_OUTCOMES)[number];

/** Board lanes include semantic completion without extending cached_status. */
export const SESSION_BOARD_COLUMNS = [
  'active',
  'needs_input',
  'blocked',
  'ready',
  'done',
] as const;

export type SessionBoardColumn = (typeof SESSION_BOARD_COLUMNS)[number];

export function getSessionBoardColumn(input: {
  cachedStatus: SessionStatus | null;
  judgmentStatus?: SessionStatusJudgmentOutcome | null;
}): SessionBoardColumn {
  // Runtime status remains authoritative when work or a structured request is
  // still live. Model judgment only refines a settled, otherwise-ready row.
  if (input.cachedStatus === 'needs_input') return 'needs_input';
  if (input.cachedStatus === 'active') return 'active';
  if (input.cachedStatus === 'blocked') return 'blocked';

  switch (input.judgmentStatus) {
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'needs_input':
      return 'needs_input';
    default:
      return 'ready';
  }
}

export const SESSION_PRIVACY_VALUES = ['shared', 'private'] as const;

export type SessionPrivacy = (typeof SESSION_PRIVACY_VALUES)[number];

export function getSessionStatusLabel(status: SessionStatus | string): string {
  return status.replace('_', ' ');
}
