/**
 * Joins an API endpoint path onto a configured base URL, preserving any path
 * prefix the base carries.
 *
 * `new URL(path, base)` is the wrong tool here: it resolves `path` against
 * `base` as a *document* URL, so unless `base` ends in `/` its last segment is
 * replaced rather than kept. Deployments that reverse-proxy the API under a
 * prefix — the self-hosted installer default is
 * `https://<domain>/_roomote-api` — lose that prefix and the request silently
 * lands on whatever the edge routes as its catch-all.
 */
export function resolveApiUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = normalizeApiBaseUrl(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${normalizedBaseUrl}${normalizedPath}`;
}

/** Trims trailing slashes so a base URL can be concatenated with a path. */
function normalizeApiBaseUrl(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* / */) {
    end -= 1;
  }

  return value.slice(0, end);
}
