type ObservedFetchOptions = {
  serviceName: string;
  slowRequestThresholdMs: number;
  fetchImpl?: typeof fetch;
  log?: Pick<Console, 'warn'>;
  internalHosts?: Iterable<string>;
  internalDomainSuffixes?: Iterable<string>;
};

export type InternalRequestUrlOptions = {
  internalHosts?: Iterable<string>;
  internalDomainSuffixes?: Iterable<string>;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const OBSERVED_FETCH_SYMBOL = Symbol.for('roomote.observedFetch');

type ObservedFetch = typeof fetch & {
  [OBSERVED_FETCH_SYMBOL]?: true;
};

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase();
}

function parseHostname(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    return normalizeHost(new URL(value).hostname);
  } catch {
    return null;
  }
}

function isPrivateIpAddress(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const [firstPart, secondPart] = hostname.split('.');
    const first = Number(firstPart);
    const second = Number(secondPart);

    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  const normalized = hostname.toLowerCase();

  if (normalized === '::1' || normalized.startsWith('fe80:')) {
    return true;
  }

  if (
    (normalized.startsWith('fc') || normalized.startsWith('fd')) &&
    normalized.includes(':')
  ) {
    return true;
  }

  return false;
}

function matchesDomainSuffix(
  hostname: string,
  domainSuffixes: Iterable<string>,
): boolean {
  for (const suffix of domainSuffixes) {
    const normalizedSuffix = normalizeHost(suffix);

    if (
      normalizedSuffix &&
      (hostname === normalizedSuffix ||
        hostname.endsWith(`.${normalizedSuffix}`))
    ) {
      return true;
    }
  }

  return false;
}

function resolveUrl(input: RequestInfo | URL): URL | null {
  if (input instanceof URL) {
    return input;
  }

  if (input instanceof Request) {
    return new URL(input.url);
  }

  try {
    return new URL(String(input));
  } catch {
    return null;
  }
}

function redactUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function isInternalRequestUrl(
  url: URL,
  options: InternalRequestUrlOptions = {},
): boolean {
  const protocol = url.protocol.toLowerCase();

  if (protocol !== 'http:' && protocol !== 'https:') {
    return true;
  }

  const hostname = normalizeHost(url.hostname);

  if (LOOPBACK_HOSTS.has(hostname) || isPrivateIpAddress(hostname)) {
    return true;
  }

  const internalHosts = new Set(
    [...(options.internalHosts ?? [])].map(normalizeHost),
  );

  if (internalHosts.has(hostname)) {
    return true;
  }

  return matchesDomainSuffix(hostname, options.internalDomainSuffixes ?? []);
}

export function buildInternalRequestHosts(
  urls: Iterable<string | null | undefined>,
): string[] {
  const hosts = new Set<string>(LOOPBACK_HOSTS);

  for (const maybeUrl of urls) {
    const hostname = parseHostname(maybeUrl);

    if (hostname) {
      hosts.add(hostname);
    }
  }

  return [...hosts];
}

export function parseInternalRequestDomainSuffixes(
  value?: string | null,
): string[] {
  return (value ?? '').split(',').map(normalizeHost).filter(Boolean);
}

export function createObservedFetch(
  options: ObservedFetchOptions,
): typeof fetch {
  const baseFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const log = options.log ?? console;

  return async (input, init) => {
    const url = resolveUrl(input);
    const isExternalRequest = Boolean(
      url &&
      !isInternalRequestUrl(url, {
        internalHosts: options.internalHosts,
        internalDomainSuffixes: options.internalDomainSuffixes,
      }),
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    const startedAt = Date.now();
    const response = await baseFetch(input, init);
    const durationMs = Date.now() - startedAt;

    if (
      isExternalRequest &&
      durationMs >= options.slowRequestThresholdMs &&
      url
    ) {
      log.warn('[Observed External Request]', {
        service: options.serviceName,
        method,
        url: redactUrl(url),
        status: response.status,
        durationMs,
      });
    }

    return response;
  };
}

export function installGlobalObservedFetch(
  options: ObservedFetchOptions,
): void {
  const currentFetch = globalThis.fetch as ObservedFetch | undefined;

  if (currentFetch?.[OBSERVED_FETCH_SYMBOL]) {
    return;
  }

  const observedFetch = createObservedFetch(options) as ObservedFetch;
  observedFetch[OBSERVED_FETCH_SYMBOL] = true;
  globalThis.fetch = observedFetch;
}
