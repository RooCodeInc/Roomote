/**
 * Constants for the proactive PR conflict resolution feature.
 *
 * Re-exports from @roomote/types for convenience, plus module-local defaults.
 */
export {
  AUTO_RESOLVE_CONFLICTS_LABEL,
  DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS,
  DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
  MERGEABILITY_MAX_ATTEMPTS,
} from '@roomote/types';

/** Redis key prefix for per-repo concurrency locks. */
export const CONFLICT_LOCK_PREFIX = 'conflict-resolution:lock:';

/** TTL (seconds) for the per-repo concurrency lock. */
export const CONFLICT_LOCK_TTL_SECONDS = 15 * 60; // 15 minutes

export const LOG_PREFIX = '[conflictResolution]';
