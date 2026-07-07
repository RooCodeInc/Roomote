const SANDBOX_REPO_PATH_PREFIX = '/sandbox/repos/';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Removes sandbox clone-path prefixes from display strings so users only see
 * repo-relative roots (e.g. Roomote/apps/web/...).
 */
export function sanitizeSandboxPathString(value: string): string {
  return value.includes(SANDBOX_REPO_PATH_PREFIX)
    ? value.split(SANDBOX_REPO_PATH_PREFIX).join('')
    : value;
}

/**
 * Deeply sanitizes nested values that may contain sandbox file paths.
 */
export function sanitizeSandboxPathsForDisplay<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeSandboxPathString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSandboxPathsForDisplay(item)) as T;
  }

  if (isPlainObject(value)) {
    const sanitizedEntries = Object.entries(value).map(([key, item]) => [
      key,
      sanitizeSandboxPathsForDisplay(item),
    ]);

    return Object.fromEntries(sanitizedEntries) as T;
  }

  return value;
}

export { SANDBOX_REPO_PATH_PREFIX };
