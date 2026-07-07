/**
 * Converts concrete URLs into route patterns before they leave the browser,
 * so telemetry never carries repository names, task ids, tokens, or other
 * identifying path content. Query strings are dropped except on the
 * explicit allowlist below.
 */

const DYNAMIC_ROUTE_MATCHERS: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern: /^\/settings\/environments\/[^/]+\/edit$/,
    replacement: '/settings/environments/[environmentId]/edit',
  },
  {
    pattern: /^\/settings\/cloud-projects\/projects\/[^/]+\/edit$/,
    replacement: '/settings/cloud-projects/projects/[environmentId]/edit',
  },
  { pattern: /^\/invite\/[^/]+$/, replacement: '/invite/[token]' },
  { pattern: /^\/sign-in(\/.*)?$/, replacement: '/sign-in' },
];

/**
 * Route-pattern prefixes whose query strings are useful, non-identifying
 * signal (setup wizard step state). Everything else loses its query string.
 */
const QUERY_STRING_ALLOWED_PREFIXES: readonly string[] = ['/setup'];

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
// Long lowercase alphanumeric segments containing at least one digit look
// like generated ids (task ids, nanoids, tokens), not route words.
const ID_LIKE_SEGMENT = /^(?=.*\d)[a-z0-9_-]{8,}$/i;

function redactSegment(segment: string): string {
  if (
    UUID_SEGMENT.test(segment) ||
    NUMERIC_SEGMENT.test(segment) ||
    ID_LIKE_SEGMENT.test(segment)
  ) {
    return '[id]';
  }
  return segment;
}

/**
 * The whole /task/[taskId] subtree carries the task id as its second
 * segment, and task ids are base-36 (they can be all letters), so the
 * generic digit-based redaction cannot be trusted here. Always replace the
 * id segment and keep the known static sub-route words.
 */
function normalizeTaskPath(pathname: string): string | null {
  const match = pathname.match(/^\/task\/[^/]+(\/.*)?$/);
  if (!match) {
    return null;
  }

  const rest = match[1] ?? '';
  if (rest.startsWith('/artifacts')) {
    return '/task/[taskId]/artifacts/[path]';
  }
  if (rest.startsWith('/previews')) {
    return '/task/[taskId]/previews/[segments]';
  }

  const restSegments = rest.split('/').filter(Boolean).map(redactSegment);
  return ['/task/[taskId]', ...restSegments].join('/');
}

/** @public */
export interface NormalizedPath {
  path: string;
  search?: string;
}

export function normalizePath(
  rawPathname: string,
  rawSearch?: string,
): NormalizedPath {
  const pathname = rawPathname.split('?')[0] ?? '/';

  let path: string | null = normalizeTaskPath(pathname);

  if (path === null) {
    for (const matcher of DYNAMIC_ROUTE_MATCHERS) {
      if (matcher.pattern.test(pathname)) {
        path = matcher.replacement;
        break;
      }
    }
  }

  if (path === null) {
    path =
      '/' + pathname.split('/').filter(Boolean).map(redactSegment).join('/');
  }

  const search = rawSearch?.replace(/^\?/, '') ?? '';
  const includeSearch =
    search.length > 0 &&
    QUERY_STRING_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));

  return includeSearch ? { path, search } : { path };
}
