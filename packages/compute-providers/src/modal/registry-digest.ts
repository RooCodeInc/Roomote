/**
 * Resolves a mutable image tag (`ghcr.io/org/worker:develop`) to a
 * digest-pinned reference (`ghcr.io/org/worker@sha256:...`).
 *
 * Modal caches `images.fromRegistry(ref)` by the ref string, so a mutable tag
 * freezes at whatever the registry served the first time it was built. Pinning
 * the digest changes the image definition whenever the tag moves, which makes
 * Modal pull the new image instead of silently reusing a months-old build.
 */

import { LRUCache } from 'lru-cache';

const DIGEST_CACHE_TTL_MS = 60_000;
/**
 * How long a failed lookup is remembered before the registry is retried, so a
 * registry outage costs one timeout per window instead of one per spawn.
 */
const DIGEST_FAILURE_CACHE_TTL_MS = 15_000;

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

/**
 * Tags the release pipeline publishes exactly once and never moves:
 * `develop-<sha>` / `main-<sha>` channel builds, `v*` releases, and raw
 * commit SHAs. These never need a registry lookup to stay fresh.
 */
const IMMUTABLE_TAG_PATTERN =
  /^(?:(?:develop|main)-[0-9a-f]{7,40}|v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|[0-9a-f]{40})$/u;

/** True for tags that are published once and never re-pointed. */
export function isImmutableImageTag(tag: string | undefined): boolean {
  return tag !== undefined && IMMUTABLE_TAG_PATTERN.test(tag);
}

interface ParsedImageRef {
  /** Registry host, e.g. `ghcr.io` or `registry-1.docker.io`. */
  registry: string;
  /** Repository path without the registry, e.g. `roocodeinc/roomote-worker`. */
  repository: string;
  tag: string | undefined;
  digest: string | undefined;
}

/**
 * Parses a registry-qualified image reference. Returns `null` for refs that
 * are not registry-qualified (bare local tags such as `roomote-worker:local`)
 * because those cannot be looked up remotely anyway.
 */
export function parseImageRef(ref: string): ParsedImageRef | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  let rest = trimmed;
  let digest: string | undefined;
  const atIndex = rest.indexOf('@');
  if (atIndex !== -1) {
    digest = rest.slice(atIndex + 1);
    rest = rest.slice(0, atIndex);
    if (!DIGEST_PATTERN.test(digest)) return null;
  }

  const firstSlash = rest.indexOf('/');
  if (firstSlash === -1) return null;

  const firstSegment = rest.slice(0, firstSlash);
  const looksLikeRegistry =
    firstSegment.includes('.') ||
    firstSegment.includes(':') ||
    firstSegment === 'localhost';

  let registry: string;
  let repositoryWithTag: string;
  if (looksLikeRegistry) {
    registry = firstSegment;
    repositoryWithTag = rest.slice(firstSlash + 1);
  } else {
    registry = 'docker.io';
    repositoryWithTag = rest;
  }

  if (registry === 'docker.io' || registry === 'index.docker.io') {
    registry = DOCKER_HUB_REGISTRY;
    if (!repositoryWithTag.includes('/')) {
      repositoryWithTag = `library/${repositoryWithTag}`;
    }
  }

  let tag: string | undefined;
  let repository = repositoryWithTag;
  const lastColon = repositoryWithTag.lastIndexOf(':');
  if (lastColon !== -1 && !repositoryWithTag.slice(lastColon).includes('/')) {
    tag = repositoryWithTag.slice(lastColon + 1);
    repository = repositoryWithTag.slice(0, lastColon);
  }

  if (!repository) return null;

  return {
    registry,
    repository,
    tag: tag || (digest ? undefined : 'latest'),
    digest,
  };
}

interface AuthChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parses a `WWW-Authenticate` header into its challenges. Handles quoted and
 * bare (RFC 7235 token) parameter values and comma-separated challenge lists
 * such as `Bearer realm="...",service="...", Basic realm="..."`. Values are
 * only used when a challenge matches a scheme we know how to satisfy.
 */
export function parseWwwAuthenticate(header: string): AuthChallenge[] {
  const challenges: AuthChallenge[] = [];
  let current: AuthChallenge | undefined;

  const token =
    /([A-Za-z][A-Za-z0-9._~+/-]*)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+)))?/gu;
  for (const match of header.matchAll(token)) {
    const [, name, quoted, bare] = match;
    if (quoted === undefined && bare === undefined) {
      // A bare word (no `=`) starts a new challenge with that scheme.
      current = { scheme: name!.toLowerCase(), params: {} };
      challenges.push(current);
      continue;
    }
    if (!current) continue;
    current.params[name!.toLowerCase()] =
      quoted !== undefined ? quoted.replace(/\\(.)/gu, '$1') : bare!;
  }

  return challenges;
}

function registrySite(host: string): string {
  const labels = host.toLowerCase().replace(/:\d+$/u, '').split('.');
  return labels.slice(-2).join('.');
}

/**
 * Refuses to present registry credentials to a token endpoint the registry
 * did not plausibly own: the realm must be HTTPS and share the registry's
 * site (`registry-1.docker.io` -> `auth.docker.io` is fine; a mirror relaying
 * an upstream `ghcr.io` challenge, or an attacker-controlled realm, is not).
 */
function assertTrustedTokenRealm(realm: URL, registry: string): void {
  if (realm.protocol !== 'https:') {
    throw new Error(
      `refusing to request a registry token over ${realm.protocol} from ${realm.origin}`,
    );
  }
  if (registrySite(realm.hostname) !== registrySite(registry)) {
    throw new Error(
      `refusing to send registry credentials for ${registry} to token realm ${realm.origin}`,
    );
  }
}

function basicAuthorization(
  username: string | undefined,
  password: string | undefined,
): string | undefined {
  if (!username || !password) return undefined;
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

interface ResolveImageRefDigestOptions {
  ref: string;
  registryUsername?: string;
  registryPassword?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Caller abort (for example the sandbox spawn being canceled). */
  signal?: AbortSignal;
}

async function fetchBearerToken(
  challenge: AuthChallenge,
  parsed: ParsedImageRef,
  options: ResolveImageRefDigestOptions,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const { realm, scope: _ignoredScope, ...params } = challenge.params;
  if (!realm) {
    throw new Error('registry Bearer challenge did not include a realm');
  }
  const url = new URL(realm);
  assertTrustedTokenRealm(url, parsed.registry);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // Some registries (ghcr.io) answer a rejected Basic header with a
  // placeholder scope, so always ask for the repository we actually need.
  url.searchParams.set('scope', `repository:${parsed.repository}:pull`);

  const authorization = basicAuthorization(
    options.registryUsername,
    options.registryPassword,
  );
  let response = await fetchImpl(url, {
    headers: authorization ? { Authorization: authorization } : {},
    signal,
  });
  if (authorization && (response.status === 401 || response.status === 403)) {
    // Stale or under-scoped registry credentials must not hide a public
    // image: retry the token request anonymously before giving up.
    response = await fetchImpl(url, { signal });
  }
  if (!response.ok) {
    throw new Error(
      `registry token request failed with status ${response.status}`,
    );
  }

  const body = (await response.json()) as {
    token?: unknown;
    access_token?: unknown;
  };
  const token =
    typeof body.token === 'string'
      ? body.token
      : typeof body.access_token === 'string'
        ? body.access_token
        : undefined;
  if (!token) {
    throw new Error('registry token response did not include a token');
  }
  return token;
}

/**
 * Looks up the current digest for `ref` via the OCI distribution API and
 * returns the digest-pinned reference. Throws when the registry cannot be
 * queried; callers decide whether to fall back to the tag.
 */
export async function resolveImageRefDigest(
  options: ResolveImageRefDigestOptions,
): Promise<string> {
  const parsed = parseImageRef(options.ref);
  if (!parsed) {
    throw new Error(`image ref "${options.ref}" is not registry-qualified`);
  }
  if (parsed.digest) {
    return options.ref.trim();
  }
  return resolveParsedImageRefDigest(parsed, options);
}

async function resolveParsedImageRefDigest(
  parsed: ParsedImageRef,
  options: ResolveImageRefDigestOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal
    ? AbortSignal.any([timeoutSignal, options.signal])
    : timeoutSignal;
  const manifestUrl = `https://${parsed.registry}/v2/${parsed.repository}/manifests/${parsed.tag}`;

  const head = (authorization?: string) =>
    fetchImpl(manifestUrl, {
      method: 'HEAD',
      headers: {
        Accept: MANIFEST_ACCEPT,
        ...(authorization ? { Authorization: authorization } : {}),
      },
      signal,
    });

  // Probe anonymously: the 401 challenge carries the realm and service, and
  // credentials (when configured) are presented to the token endpoint.
  let response = await head();

  if (response.status === 401) {
    const challenges = parseWwwAuthenticate(
      response.headers.get('www-authenticate') ?? '',
    );
    const bearer = challenges.find(
      (challenge) => challenge.scheme === 'bearer' && challenge.params.realm,
    );
    const basic = challenges.find((challenge) => challenge.scheme === 'basic');

    if (bearer) {
      const token = await fetchBearerToken(
        bearer,
        parsed,
        options,
        fetchImpl,
        signal,
      );
      response = await head(`Bearer ${token}`);
    } else if (basic) {
      // Docker Distribution registries secured with htpasswd-style auth
      // challenge with Basic directly; there is no token endpoint to call.
      const authorization = basicAuthorization(
        options.registryUsername,
        options.registryPassword,
      );
      if (!authorization) {
        throw new Error(
          `registry requires Basic credentials for ${manifestUrl} and none are configured`,
        );
      }
      response = await head(authorization);
    } else {
      throw new Error(
        `registry returned 401 for ${manifestUrl} without a usable challenge`,
      );
    }
  }

  if (!response.ok) {
    throw new Error(
      `registry manifest lookup failed with status ${response.status} for ${manifestUrl}`,
    );
  }

  const digest = response.headers.get('docker-content-digest')?.trim();
  if (!digest || !DIGEST_PATTERN.test(digest)) {
    throw new Error(
      `registry did not return a usable Docker-Content-Digest for ${manifestUrl}`,
    );
  }

  const registry =
    parsed.registry === DOCKER_HUB_REGISTRY ? 'docker.io' : parsed.registry;
  return `${registry}/${parsed.repository}@${digest}`;
}

interface DigestFetchContext {
  ref: string;
  parsed: ParsedImageRef;
  options: ResolveImageRefDigestOptions;
}

let cacheClock: () => number = Date.now;

/**
 * Per-process digest cache keyed by ref + registry user. `fetch()` coalesces
 * concurrent lookups for the same key, and a stale (expired) entry is handed
 * back to `fetchMethod` so a failed refresh can keep serving the last good
 * digest instead of dropping back to the mutable tag.
 */
const digestCache = new LRUCache<string, string, DigestFetchContext>({
  max: 32,
  ttl: DIGEST_CACHE_TTL_MS,
  // A handful of entries read on the spawn path; skip the perf.now() debounce
  // so expiry follows the clock exactly (and the fake clock in tests).
  ttlResolution: 0,
  perf: { now: () => cacheClock() },
  // A rejected refresh (caller abort) must neither drop the last good digest
  // nor fail callers who can be served from it.
  noDeleteOnFetchRejection: true,
  allowStaleOnFetchRejection: true,
  fetchMethod: async (
    _key,
    staleValue,
    { options: entryOptions, signal, context },
  ) => {
    const { ref, parsed, options } = context;
    try {
      const pinned = await resolveParsedImageRefDigest(parsed, {
        ...options,
        ref,
        signal: options.signal
          ? AbortSignal.any([signal, options.signal])
          : signal,
      });
      console.log(
        `[ModalClient] Pinned base image ${JSON.stringify({ ref, pinned })}`,
      );
      return pinned;
    } catch (error) {
      if (options.signal?.aborted) {
        // The caller gave up; keep the stale entry (if any) and let the next
        // spawn retry immediately.
        throw error;
      }

      const lastPinned =
        staleValue && parseImageRef(staleValue)?.digest
          ? staleValue
          : undefined;
      const fallback = lastPinned ?? ref;
      // Remember the failure briefly so an outage costs one lookup timeout
      // per window instead of one per spawn.
      entryOptions.ttl = DIGEST_FAILURE_CACHE_TTL_MS;
      console.warn(
        `[ModalClient] Could not resolve base image digest; ${
          lastPinned
            ? 'using last resolved digest'
            : 'using tag as-is (Modal may reuse a stale cached image)'
        } ${JSON.stringify({
          ref,
          fallback,
          retryAfterMs: DIGEST_FAILURE_CACHE_TTL_MS,
          error: error instanceof Error ? error.message : String(error),
        })}`,
      );
      return fallback;
    }
  },
});

/**
 * Pins a Modal base image ref to its current digest so Modal's image cache key
 * tracks the tag. Refs that are already digest-pinned, not registry-qualified,
 * or carry an immutable release tag are returned unchanged without touching
 * the registry. When the registry cannot be queried the last successfully
 * resolved digest is reused; only when no digest has ever been resolved in
 * this process does it fall back to the original tag (and logs), so a
 * registry hiccup never blocks sandbox creation.
 */
export async function pinModalBaseImageRef(
  options: ResolveImageRefDigestOptions,
): Promise<string> {
  const ref = options.ref.trim();
  const parsed = parseImageRef(ref);
  if (!parsed || parsed.digest || isImmutableImageTag(parsed.tag)) {
    return ref;
  }

  const cacheKey = `${ref} ${options.registryUsername ?? ''}`;
  try {
    const pinned = await digestCache.fetch(cacheKey, {
      context: { ref, parsed, options },
    });
    return pinned ?? ref;
  } catch {
    // Only reachable when the caller aborted and nothing was cached yet.
    return ref;
  }
}

/** Resets the per-process digest cache, optionally with a fake clock (tests). */
export function resetModalBaseImageDigestCache(options?: {
  now?: () => number;
}): void {
  cacheClock = options?.now ?? Date.now;
  digestCache.clear();
}
