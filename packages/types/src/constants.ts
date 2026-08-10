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

export function getGitHubFollowUpMention(
  slug: string,
  roomoteMentionEnabled: boolean,
): string {
  return roomoteMentionEnabled ? '@roomote' : getGitHubAppMention(slug);
}

export const PR_BODY_ATTRIBUTION_START_MARKER =
  '<!-- roomote:pr-attribution:start -->';
export const PR_BODY_ATTRIBUTION_END_MARKER =
  '<!-- roomote:pr-attribution:end -->';
const PR_BODY_ATTRIBUTION_INLINE_PREFIX = '&#8203;';

type PrBodyAttributionMarkerMatch = {
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
};

function findPrBodyAttributionMarkers(
  body: string,
): PrBodyAttributionMarkerMatch | null {
  const startMarker = body.indexOf(PR_BODY_ATTRIBUTION_START_MARKER);
  if (startMarker === -1) {
    return null;
  }

  const start = startMarker + PR_BODY_ATTRIBUTION_START_MARKER.length;
  const end = body.indexOf(PR_BODY_ATTRIBUTION_END_MARKER, start);
  if (end === -1 || body.slice(start, end).includes('\n')) {
    return null;
  }

  const lineStart = body.lastIndexOf('\n', startMarker - 1) + 1;
  if (
    !/^[ \t]*>[ \t]*(?:&#8203;)?$/u.test(body.slice(lineStart, startMarker))
  ) {
    return null;
  }

  return {
    start,
    end,
    lineStart,
    lineEnd:
      body.indexOf('\n', end) === -1 ? body.length : body.indexOf('\n', end),
  };
}

export function formatPrBodyAttribution(
  provenance: string,
  instruction: string,
): string {
  // Leading with an entity keeps the marker inline. A comment immediately
  // after the blockquote marker starts a raw HTML block in CommonMark/GFM.
  return `> ${PR_BODY_ATTRIBUTION_INLINE_PREFIX}${PR_BODY_ATTRIBUTION_START_MARKER}${provenance}${PR_BODY_ATTRIBUTION_END_MARKER} ${instruction}`;
}

export function findPrBodyAttributionLine(body: string): string | null {
  const markers = findPrBodyAttributionMarkers(body);
  return markers ? `> ${body.slice(markers.start, markers.end)}` : null;
}

export function preservePrBodyAttribution(
  body: string,
  existingBody: string,
): string {
  const current = findPrBodyAttributionMarkers(body);
  const existing = findPrBodyAttributionMarkers(existingBody);
  if (!current || !existing) {
    return body;
  }

  return `${body.slice(0, current.start)}${existingBody.slice(existing.start, existing.end)}${body.slice(current.end)}`;
}

/**
 * Rewrite follow-up app mentions in the Roomote PR-body attribution line to
 * the deployment's current follow-up handle: the configured GitHub App slug,
 * or the shorter `@roomote` alias when that setting is enabled.
 *
 * Only the marker-containing line is rewritten; other body text that happens
 * to mention `@roomote` is left unchanged.
 */
export function normalizePrBodyAttributionAppMention(
  body: string,
  githubAppSlug: string,
  roomoteMentionEnabled = false,
): string {
  const normalizedSlug = githubAppSlug.trim();

  if (!normalizedSlug) {
    return body;
  }

  const mention = getGitHubFollowUpMention(
    normalizedSlug,
    roomoteMentionEnabled,
  );
  const markers = findPrBodyAttributionMarkers(body);
  if (!markers) {
    return body;
  }

  const line = body.slice(markers.lineStart, markers.lineEnd);
  const rewrittenLine = line.replace(
    /(mention(?:ing)?\s+)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/g,
    `$1${mention}`,
  );

  if (rewrittenLine === line) {
    return body;
  }

  return `${body.slice(0, markers.lineStart)}${rewrittenLine}${body.slice(markers.lineEnd)}`;
}

/**
 * Rewrite only the server-owned provenance text between attribution markers.
 * Unmarked bodies are deliberately left alone.
 */
export function rewritePrBodyAttribution(
  body: string,
  displayName: string | null,
): string {
  const markers = findPrBodyAttributionMarkers(body);
  if (!markers) {
    return body;
  }

  const normalizedDisplayName = displayName?.trim().replace(/[\r\n]+/g, ' ');
  const provenance = normalizedDisplayName
    ? `Opened on behalf of ${normalizedDisplayName}.`
    : 'Created by Roomote.';

  return `${body.slice(0, markers.start)}${provenance}${body.slice(markers.end)}`;
}

/**
 * Hosted-product GitHub App slugs Roomote always treats as its own bots.
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
