/**
 * True when a hostname refers to the local machine and is never publicly
 * routable: `localhost`, `*.localhost`, IPv4/IPv6 loopback (with or without
 * brackets), or the unspecified bind-all address `0.0.0.0`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}
