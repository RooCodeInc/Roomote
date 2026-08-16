/** Any address in the IPv4 loopback range `127.0.0.0/8`, not just `127.0.0.1`. */
const IPV4_LOOPBACK_PATTERN =
  /^127(?:\.(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])){3}$/;

/**
 * True when a hostname refers to the local machine and is never publicly
 * routable: `localhost`, `*.localhost`, IPv4/IPv6 loopback (with or without
 * brackets), or the unspecified bind-all addresses `0.0.0.0` and `::`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    IPV4_LOOPBACK_PATTERN.test(normalized) ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '::' ||
    normalized === '[::]'
  );
}
