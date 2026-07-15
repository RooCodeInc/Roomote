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
 * Leading Roomote PR provenance blockquote:
 * `> Created by Roomote. ...` or `> Opened on behalf of <name>. ...`
 * (including the historical "from an unlinked ..." attribution form).
 *
 * Parsed with linear string scans so untrusted PR bodies cannot trigger
 * polynomial regular-expression matching.
 */
function matchPrBodyAttributionLine(
  firstLine: string,
): { prefix: string; instruction: string } | null {
  if (!firstLine.startsWith('>')) {
    return null;
  }

  let index = 1;
  while (
    index < firstLine.length &&
    (firstLine.charCodeAt(index) === 32 /* space */ ||
      firstLine.charCodeAt(index) === 9) /* tab */
  ) {
    index += 1;
  }

  const contentStart = index;
  const content = firstLine.slice(contentStart);

  const createdByPrefix = 'Created by Roomote';
  if (content.startsWith(createdByPrefix)) {
    let sentenceEnd = createdByPrefix.length;

    if (content.startsWith(' from an unlinked ', sentenceEnd)) {
      sentenceEnd += ' from an unlinked '.length;
      while (
        sentenceEnd < content.length &&
        content.charCodeAt(sentenceEnd) !== 46 /* . */
      ) {
        sentenceEnd += 1;
      }
    }

    if (content.charCodeAt(sentenceEnd) !== 46 /* . */) {
      return null;
    }

    sentenceEnd += 1;
    while (
      sentenceEnd < content.length &&
      (content.charCodeAt(sentenceEnd) === 32 ||
        content.charCodeAt(sentenceEnd) === 9)
    ) {
      sentenceEnd += 1;
    }

    return {
      prefix: firstLine.slice(0, contentStart + sentenceEnd),
      instruction: content.slice(sentenceEnd),
    };
  }

  const openedPrefix = 'Opened on behalf of ';
  if (content.startsWith(openedPrefix)) {
    let sentenceEnd = openedPrefix.length;
    while (
      sentenceEnd < content.length &&
      content.charCodeAt(sentenceEnd) !== 46 /* . */
    ) {
      sentenceEnd += 1;
    }

    if (content.charCodeAt(sentenceEnd) !== 46 /* . */) {
      return null;
    }

    sentenceEnd += 1;
    while (
      sentenceEnd < content.length &&
      (content.charCodeAt(sentenceEnd) === 32 ||
        content.charCodeAt(sentenceEnd) === 9)
    ) {
      sentenceEnd += 1;
    }

    return {
      prefix: firstLine.slice(0, contentStart + sentenceEnd),
      instruction: content.slice(sentenceEnd),
    };
  }

  return null;
}

/**
 * Rewrite follow-up app mentions in the Roomote PR-body attribution line so
 * they always use the deployment-configured GitHub App slug (for example
 * `@roomote-roomote`) instead of a stale hostname default like `@roomote`.
 *
 * Only the leading attribution blockquote is rewritten; other body text that
 * happens to mention `@roomote` is left unchanged.
 */
export function normalizePrBodyAttributionAppMention(
  body: string,
  githubAppSlug: string,
): string {
  const normalizedSlug = githubAppSlug.trim();

  if (!normalizedSlug) {
    return body;
  }

  const mention = getGitHubAppMention(normalizedSlug);
  const firstNewline = body.indexOf('\n');
  const firstLine = firstNewline === -1 ? body : body.slice(0, firstNewline);
  const remainder = firstNewline === -1 ? '' : body.slice(firstNewline);
  const match = matchPrBodyAttributionLine(firstLine);

  if (!match) {
    return body;
  }

  const { prefix, instruction } = match;
  const rewrittenInstruction = instruction.replace(
    /(mention(?:ing)?\s+)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/g,
    `$1${mention}`,
  );

  if (rewrittenInstruction === instruction) {
    return body;
  }

  return `${prefix}${rewrittenInstruction}${remainder}`;
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
