import { lookup as nodeDnsLookup } from 'node:dns';
import { isIP } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

/**
 * SSRF-guarded outbound fetch for operator-supplied URLs (custom MCP servers
 * and their OAuth discovery chains).
 *
 * Historically the control plane never fetched arbitrary operator URLs (see
 * the assumption documented in lib/mcp/oauth.ts), so no guard existed. Custom
 * MCP servers break that assumption: the API proxies task traffic to
 * admin-entered URLs and the OAuth flow fetches discovery documents from
 * URLs the *remote server* supplies (WWW-Authenticate hints,
 * authorization_servers lists). Every one of those fetches must go through
 * this module.
 *
 * Defenses:
 * - URL hygiene: http(s) only, no userinfo.
 * - Address vetting: every DNS answer (not just the first) is checked against
 *   a private/special-range blocklist before connecting; IP literals are
 *   vetted directly.
 * - Pinning: the undici Agent connects to the vetted address itself, so a
 *   second resolution cannot rebind the hostname to an internal address
 *   between check and connect (DNS-rebinding TOCTOU).
 * - Redirects are refused by default: a redirect is a server-controlled URL
 *   and following it would restart the whole problem with credentials
 *   attached.
 *
 * Self-hosted deployments that intentionally run MCP servers on private
 * networks can allow specific ranges via R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS
 * (threaded in by the caller as `allowedPrivateCidrs`). It is a CIDR list
 * rather than a boolean so opening one internal host does not re-expose every
 * adjacent service (database, cache, object store).
 */

export class SafeFetchViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchViolationError';
  }
}

interface ParsedCidr {
  family: 4 | 6;
  value: bigint;
  prefix: number;
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');

  if (parts.length !== 4) {
    return null;
  }

  let value = 0n;

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }

    const octet = Number(part);

    if (octet > 255) {
      return null;
    }

    value = (value << 8n) | BigInt(octet);
  }

  return value;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const zoneIndex = ip.indexOf('%');
  const withoutZone = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);
  const doubleColonSplit = withoutZone.split('::');

  if (doubleColonSplit.length > 2) {
    return null;
  }

  const expandGroups = (segment: string): string[] | null => {
    if (segment === '') {
      return [];
    }

    const groups: string[] = [];

    for (const group of segment.split(':')) {
      if (group.includes('.')) {
        const embedded = ipv4ToBigInt(group);

        if (embedded === null) {
          return null;
        }

        groups.push(
          ((embedded >> 16n) & 0xffffn).toString(16),
          (embedded & 0xffffn).toString(16),
        );
      } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) {
        groups.push(group);
      } else {
        return null;
      }
    }

    return groups;
  };

  const head = expandGroups(doubleColonSplit[0]!);
  const tail =
    doubleColonSplit.length === 2 ? expandGroups(doubleColonSplit[1]!) : [];

  if (head === null || tail === null) {
    return null;
  }

  const missing = 8 - head.length - tail.length;

  if (doubleColonSplit.length === 2 ? missing < 0 : missing !== 0) {
    return null;
  }

  const groups = [
    ...head,
    ...Array.from({ length: missing }, () => '0'),
    ...tail,
  ];

  let value = 0n;

  for (const group of groups) {
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }

  return value;
}

function parseAddress(ip: string): { family: 4 | 6; value: bigint } | null {
  const family = isIP(ip);

  if (family === 4) {
    const value = ipv4ToBigInt(ip);
    return value === null ? null : { family: 4, value };
  }

  if (family === 6) {
    const value = ipv6ToBigInt(ip);
    return value === null ? null : { family: 6, value };
  }

  return null;
}

export function parseCidrList(cidrs: string | undefined): ParsedCidr[] {
  if (!cidrs) {
    return [];
  }

  const parsed: ParsedCidr[] = [];

  for (const entry of cidrs.split(',')) {
    const trimmed = entry.trim();

    if (!trimmed) {
      continue;
    }

    const [address, prefixText] = trimmed.split('/');
    const parsedAddress = parseAddress(address ?? '');

    if (!parsedAddress) {
      throw new SafeFetchViolationError(
        `Invalid CIDR '${trimmed}' in allowed private ranges.`,
      );
    }

    const maxPrefix = parsedAddress.family === 4 ? 32 : 128;
    const prefix =
      prefixText === undefined ? maxPrefix : Number.parseInt(prefixText, 10);

    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new SafeFetchViolationError(`Invalid CIDR prefix in '${trimmed}'.`);
    }

    parsed.push({ ...parsedAddress, prefix });
  }

  return parsed;
}

function cidrContains(cidr: ParsedCidr, family: 4 | 6, value: bigint): boolean {
  if (cidr.family !== family) {
    return false;
  }

  const bits = family === 4 ? 32 : 128;
  const shift = BigInt(bits - cidr.prefix);

  return value >> shift === cidr.value >> shift;
}

function ipv4Cidr(text: string): ParsedCidr {
  const [address, prefix] = text.split('/');
  return { family: 4, value: ipv4ToBigInt(address!)!, prefix: Number(prefix) };
}

function ipv6Cidr(text: string): ParsedCidr {
  const [address, prefix] = text.split('/');
  return { family: 6, value: ipv6ToBigInt(address!)!, prefix: Number(prefix) };
}

/**
 * Special-use and private ranges that operator-supplied URLs must never reach
 * without an explicit CIDR allowance. Notably includes ranges the repo's
 * observability helper does not (169.254.0.0/16 cloud metadata, 100.64.0.0/10
 * CGNAT, 0.0.0.0/8) — that helper is a logging heuristic, not a control.
 */
const BLOCKED_IPV4_RANGES: ParsedCidr[] = [
  ipv4Cidr('0.0.0.0/8'),
  ipv4Cidr('10.0.0.0/8'),
  ipv4Cidr('100.64.0.0/10'),
  ipv4Cidr('127.0.0.0/8'),
  ipv4Cidr('169.254.0.0/16'),
  ipv4Cidr('172.16.0.0/12'),
  ipv4Cidr('192.0.0.0/24'),
  ipv4Cidr('192.168.0.0/16'),
  ipv4Cidr('198.18.0.0/15'),
  ipv4Cidr('224.0.0.0/4'),
  ipv4Cidr('240.0.0.0/4'),
];

const BLOCKED_IPV6_RANGES: ParsedCidr[] = [
  ipv6Cidr('::/128'),
  ipv6Cidr('::1/128'),
  ipv6Cidr('fc00::/7'),
  ipv6Cidr('fe80::/10'),
  ipv6Cidr('ff00::/8'),
];

const IPV4_MAPPED_PREFIX = ipv6Cidr('::ffff:0:0/96');
const NAT64_PREFIX = ipv6Cidr('64:ff9b::/96');

/**
 * Returns null when the address is allowed, or a human-readable reason when
 * it must be refused. `allowedPrivateCidrs` are consulted before the
 * blocklist so self-hosters can open specific internal ranges.
 */
export function checkAddressAllowed(
  ip: string,
  allowedPrivateCidrs: ParsedCidr[],
): string | null {
  const parsed = parseAddress(ip);

  if (!parsed) {
    return `Address '${ip}' is not a valid IP address.`;
  }

  // Check IPv4-mapped / NAT64 IPv6 addresses as their embedded IPv4 value so
  // `::ffff:10.0.0.1` cannot bypass the v4 blocklist.
  if (
    parsed.family === 6 &&
    (cidrContains(IPV4_MAPPED_PREFIX, 6, parsed.value) ||
      cidrContains(NAT64_PREFIX, 6, parsed.value))
  ) {
    const embedded = parsed.value & 0xffffffffn;
    const dotted = [
      (embedded >> 24n) & 0xffn,
      (embedded >> 16n) & 0xffn,
      (embedded >> 8n) & 0xffn,
      embedded & 0xffn,
    ].join('.');

    return checkAddressAllowed(dotted, allowedPrivateCidrs);
  }

  if (
    allowedPrivateCidrs.some((cidr) =>
      cidrContains(cidr, parsed.family, parsed.value),
    )
  ) {
    return null;
  }

  const blockedRanges =
    parsed.family === 4 ? BLOCKED_IPV4_RANGES : BLOCKED_IPV6_RANGES;

  if (
    blockedRanges.some((cidr) =>
      cidrContains(cidr, parsed.family, parsed.value),
    )
  ) {
    return (
      `Address '${ip}' is in a private or special-use range. Self-hosted ` +
      `deployments can allow specific ranges with ` +
      `R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS.`
    );
  }

  return null;
}

/** URL hygiene for operator-supplied endpoints: http(s) only, no userinfo. */
export function validateEgressUrl(value: string | URL): URL {
  let url: URL;

  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new SafeFetchViolationError(
      `'${String(value)}' is not an absolute URL.`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchViolationError(
      `'${url.toString()}' must use http or https.`,
    );
  }

  if (url.username || url.password) {
    throw new SafeFetchViolationError(
      `'${url.toString()}' must not contain credentials.`,
    );
  }

  return url;
}

export type DnsLookupFn = typeof nodeDnsLookup;

export interface SafeFetchOptions {
  /** Parsed value of R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS. */
  allowedPrivateCidrs?: string;
  /** Override the DNS resolver (tests only). */
  lookup?: DnsLookupFn;
  /** Abort signal / timeout forwarded to the fetch. */
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

interface GuardedAgentConfig {
  allowedPrivateCidrs: string | undefined;
  lookup: DnsLookupFn;
}

function createGuardedAgent(config: GuardedAgentConfig): Agent {
  const allowed = parseCidrList(config.allowedPrivateCidrs);

  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        config.lookup(
          hostname,
          { ...options, all: true, verbatim: true },
          (error, addresses) => {
            if (error) {
              callback(error, '', 4);
              return;
            }

            const results = (
              Array.isArray(addresses)
                ? addresses
                : [{ address: addresses as unknown as string, family: 4 }]
            ) as { address: string; family: number }[];

            const vetted = results.filter(
              (result) => checkAddressAllowed(result.address, allowed) === null,
            );

            if (vetted.length === 0) {
              const reason =
                results.length === 0
                  ? `DNS for '${hostname}' returned no addresses.`
                  : (checkAddressAllowed(results[0]!.address, allowed) ??
                    'refused');

              callback(new SafeFetchViolationError(reason), '', 4);
              return;
            }

            // Pin the connection to the vetted answers: undici connects to
            // these literal addresses, so no later re-resolution can rebind.
            if (options.all) {
              callback(
                null,
                vetted.map((result) => ({
                  address: result.address,
                  family: result.family,
                })) as never,
                undefined as never,
              );
            } else {
              callback(null, vetted[0]!.address, vetted[0]!.family);
            }
          },
        );
      },
    },
  });
}

const agentCache = new Map<string, Agent>();

function guardedAgentFor(config: GuardedAgentConfig): Agent {
  // Custom lookup functions are test-only; never cache those agents.
  if (config.lookup !== nodeDnsLookup) {
    return createGuardedAgent(config);
  }

  const key = config.allowedPrivateCidrs ?? '';
  let agent = agentCache.get(key);

  if (!agent) {
    agent = createGuardedAgent(config);
    agentCache.set(key, agent);
  }

  return agent;
}

/**
 * Fetch an operator-supplied URL with SSRF guards. Redirects are refused:
 * callers that legitimately need to follow one must re-validate the target
 * through this function themselves.
 */
export async function safeFetch(
  target: string | URL,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const url = validateEgressUrl(target);
  const allowed = parseCidrList(options.allowedPrivateCidrs);

  // IP literals never hit the lookup hook: vet them here.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    const reason = checkAddressAllowed(
      url.hostname.replace(/^\[|\]$/g, ''),
      allowed,
    );

    if (reason !== null) {
      throw new SafeFetchViolationError(reason);
    }
  }

  const dispatcher = guardedAgentFor({
    allowedPrivateCidrs: options.allowedPrivateCidrs,
    lookup: options.lookup ?? nodeDnsLookup,
  });

  let response;

  try {
    response = await undiciFetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      redirect: 'manual',
      dispatcher,
    });
  } catch (error) {
    // undici wraps connection-phase failures in `TypeError: fetch failed`;
    // surface the guard's own refusal directly so callers can distinguish
    // policy violations from network errors.
    if (
      error instanceof Error &&
      error.cause instanceof SafeFetchViolationError
    ) {
      throw error.cause;
    }

    throw error;
  }

  if (response.status >= 300 && response.status < 400) {
    throw new SafeFetchViolationError(
      `'${url.toString()}' answered with a redirect (${response.status}), ` +
        `which is refused for operator-supplied URLs.`,
    );
  }

  return response as unknown as Response;
}
