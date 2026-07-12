/**
 * Product name constants.
 *
 * Use these instead of hard-coding the product name so a future rename
 * only requires changing these values.
 */
export const PRODUCT_NAME = 'Roomote';
export const PRODUCT_NAME_ROUTER = `${PRODUCT_NAME} Router`;
/** Stable repository/package identity, even if the product brand changes. */
export const ROOMOTE_REPOSITORY_NAME = 'Roomote';

export const TASK_TIMEOUT_MS = 60 * 60 * 1_000;

/** Default time (ms) to keep the container alive after a task finishes, allowing follow-up interactions. */
export const DEFAULT_KEEPALIVE_MS = 30 * 60 * 1_000;

/** Default keepalive used for local development to reduce accidental idle sleep while keeping a bounded window. */
export const DEFAULT_KEEPALIVE_DEV_MS = 30 * 60 * 1_000;

/** Default delegated-task keepalive for production-like environments. */
export const DEFAULT_DELEGATED_KEEPALIVE_MS = 30 * 60 * 1_000;

/** Default automation-task keepalive after completion, leaving a short follow-up window. */
export const DEFAULT_AUTOMATION_KEEPALIVE_MS = 60 * 1_000;

/** Default maintenance-task keepalive after completion, leaving a follow-up window long enough to absorb fixer or reviewer follow-ups before sleeping. */
export const DEFAULT_MAINTENANCE_KEEPALIVE_MS = 5 * 60 * 1_000;

export const ALL_REPOSITORIES = '__all_repositories__';
export const HAS_PULL_REQUEST_FILTER_VALUE = '__has_pr__';

/**
 * Proactive PR Conflict Resolution constants
 */

/** Label that opts a PR into automatic conflict resolution. */
export const AUTO_RESOLVE_CONFLICTS_LABEL = 'roomote:auto-resolve-conflicts';

/** Only consider PRs updated within this many days for conflict scanning. */
export const DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS = 7;

/** Allowed age caps for automatic PR conflict resolution. */
export const CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS = [
  1, 3, 7, 14,
] as const;

export type ConflictResolverMaxPrAgeDays =
  (typeof CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS)[number];

/** Skip automatic conflict resolution for PRs opened longer ago than this. */
export const DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS: ConflictResolverMaxPrAgeDays = 7;

export function isConflictResolverMaxPrAgeDays(
  value: number,
): value is ConflictResolverMaxPrAgeDays {
  return (
    CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS_OPTIONS as readonly number[]
  ).includes(value);
}

/** HTML comment marker embedded in PR comments for conflict resolution. */
export const CONFLICT_RESOLUTION_COMMENT_MARKER =
  '<!-- roomote-conflict-resolution -->';

/** Minutes between mergeability re-checks when GitHub reports unknown. */
export const MERGEABILITY_RETRY_INTERVAL_MINUTES = 15;

/** Maximum number of mergeability poll attempts before giving up. */
export const MERGEABILITY_MAX_ATTEMPTS = 8;

/** Derive the GitHub bot login from the app slug (e.g. `"roomote"` → `"roomote[bot]"`). */
export function getGitHubAppBotLogin(slug: string): string {
  return `${slug}[bot]`;
}

/** Derive the user-facing mention handle from the configured app slug. */
export function getGitHubAppMention(slug: string): string {
  return `@${slug}`;
}

/**
 * Canonical mention handle every deployment listens for alongside its own
 * configured app slug, and the handle product copy advertises. Roo Code owns
 * the `roomote` GitHub App and user, so the alias cannot be claimed by a
 * third party.
 */
export const ROOMOTE_CANONICAL_GITHUB_MENTION = '@roomote';

/**
 * Roo Code-owned GitHub App slugs every deployment treats as Roomote's own
 * bots (the retired hosted product and Roo Code's internal deployments).
 * Custom deployments still add their configured slug via helpers below.
 */
export const ROOMOTE_GITHUB_HOSTED_APP_SLUGS = [
  'roomote',
  'roomote-dev',
] as const;

/**
 * Closed set of app slugs whose exact bot/`app/` logins are managed by Roomote.
 * Includes the hosted product slugs plus any configured deployment slug.
 */
export function getRoomoteGitHubAppSlugs(
  githubAppSlug?: string | null,
): string[] {
  const slugs = new Set<string>(ROOMOTE_GITHUB_HOSTED_APP_SLUGS);
  const normalizedSlug = githubAppSlug?.trim().toLowerCase();

  if (normalizedSlug) {
    slugs.add(normalizedSlug);
  }

  return Array.from(slugs);
}

/**
 * Exact Roomote-managed GitHub logins for finite allowlists (collaborators,
 * onboarding lists, etc.). Does not enumerate open `roomote-*` prefix forms —
 * those are recognized only by {@link matchesRoomoteGitHubLogin}.
 */
export function getRoomoteManagedGitHubLogins(
  githubAppSlug?: string | null,
): string[] {
  return getRoomoteGitHubAppSlugs(githubAppSlug).flatMap((slug) => [
    getGitHubAppBotLogin(slug),
    `app/${slug}`,
  ]);
}

/**
 * Full Roomote GitHub login identity policy (pure):
 * - exact bot/`app/` logins for hosted + configured app slugs
 * - any `roomote-*` / `app/roomote-*` login form
 *
 * Runtime call sites that need the deployment's effective slug should prefer
 * `@roomote/github` wrappers such as `Schemas.isRoomoteGitHubLogin`.
 */
export function matchesRoomoteGitHubLogin(
  login: string,
  githubAppSlug?: string | null,
): boolean {
  const normalizedLogin = login.toLowerCase();

  for (const managedLogin of getRoomoteManagedGitHubLogins(githubAppSlug)) {
    if (normalizedLogin === managedLogin.toLowerCase()) {
      return true;
    }
  }

  return (
    normalizedLogin.startsWith('roomote-') ||
    normalizedLogin.startsWith('app/roomote-')
  );
}
