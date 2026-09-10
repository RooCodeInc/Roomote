/**
 * Resolves a mutable image tag (`ghcr.io/org/worker:develop`) to a
 * digest-pinned reference (`ghcr.io/org/worker@sha256:...`).
 *
 * Modal caches `images.fromRegistry(ref)` by the ref string, so a mutable tag
 * freezes at whatever the registry served the first time it was built. Pinning
 * the digest changes the image definition whenever the tag moves, which makes
 * Modal pull the new image instead of silently reusing a months-old build.
 */

const DIGEST_CACHE_TTL_MS = 60_000;

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

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

function parseWwwAuthenticate(
  header: string,
): { realm: string; params: Record<string, string> } | null {
  const match = /^Bearer\s+(.*)$/iu.exec(header.trim());
  if (!match) return null;

  const params: Record<string, string> = {};
  for (const part of match[1]!.matchAll(/(\w+)="([^"]*)"/gu)) {
    params[part[1]!] = part[2]!;
  }

  const realm = params.realm;
  if (!realm) return null;
  delete params.realm;
  return { realm, params };
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
}

async function fetchBearerToken(
  challenge: { realm: string; params: Record<string, string> },
  repository: string,
  options: ResolveImageRefDigestOptions,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const url = new URL(challenge.realm);
  for (const [key, value] of Object.entries(challenge.params)) {
    url.searchParams.set(key, value);
  }
  // Some registries (ghcr.io) answer a rejected Basic header with a
  // placeholder scope, so always ask for the repository we actually need.
  url.searchParams.set('scope', `repository:${repository}:pull`);

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

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
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
    const challengeHeader = response.headers.get('www-authenticate') ?? '';
    const scheme = challengeHeader.trim().split(/\s+/u)[0]?.toLowerCase();

    if (scheme === 'basic') {
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
      const challenge = parseWwwAuthenticate(challengeHeader);
      if (!challenge) {
        throw new Error(
          `registry returned 401 for ${manifestUrl} without a usable challenge`,
        );
      }
      const token = await fetchBearerToken(
        challenge,
        parsed.repository,
        options,
        fetchImpl,
        signal,
      );
      response = await head(`Bearer ${token}`);
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

const digestCache = new Map<
  string,
  { expiresAt: number; promise: Promise<string> }
>();

/**
 * Pins a Modal base image ref to its current digest so Modal's image cache key
 * tracks the tag. Falls back to the original ref (and logs) when the registry
 * cannot be queried, so a registry hiccup never blocks sandbox creation.
 * Results are cached briefly per process to keep the lookup cheap on the
 * per-spawn path while still picking up new pushes within a minute.
 */
export async function pinModalBaseImageRef(
  options: ResolveImageRefDigestOptions & { now?: () => number },
): Promise<string> {
  const ref = options.ref.trim();
  const parsed = parseImageRef(ref);
  if (!parsed || parsed.digest) {
    return ref;
  }

  const now = options.now ?? Date.now;
  const cacheKey = `${ref} ${options.registryUsername ?? ''}`;
  const cached = digestCache.get(cacheKey);
  if (cached && cached.expiresAt > now()) {
    return cached.promise;
  }

  const promise = resolveImageRefDigest(options)
    .then((pinned) => {
      console.log(
        `[ModalClient] Pinned base image ${JSON.stringify({ ref, pinned })}`,
      );
      return pinned;
    })
    .catch((error) => {
      digestCache.delete(cacheKey);
      console.warn(
        `[ModalClient] Could not resolve base image digest; using tag as-is ${JSON.stringify(
          {
            ref,
            error: error instanceof Error ? error.message : String(error),
          },
        )}`,
      );
      return ref;
    });

  digestCache.set(cacheKey, {
    expiresAt: now() + DIGEST_CACHE_TTL_MS,
    promise,
  });

  return promise;
}

/** Clears the per-process digest cache (tests). */
export function clearModalBaseImageDigestCache(): void {
  digestCache.clear();
}
