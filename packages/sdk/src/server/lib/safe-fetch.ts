import { lookup as nodeDnsLookup } from 'node:dns';
import { isIP } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';
import { Parser } from 'htmlparser2';
import TurndownService from 'turndown';

import {
  PUBLIC_URL_FETCH_DEFAULT_TIMEOUT_SECONDS,
  PUBLIC_URL_FETCH_MAX_TIMEOUT_SECONDS,
  type PublicUrlFetchInput,
  type PublicUrlFetchResult,
} from '@roomote/types';

/**
 * SSRF-guarded outbound fetch for operator- or remote-content-supplied URLs.
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
 * - Redirects are refused by default. The explicit HEAD-only redirect helper
 *   re-runs every URL and address guard on each hop without forwarding
 *   credentials or a request body.
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
  ipv4Cidr('192.0.2.0/24'),
  ipv4Cidr('192.88.99.0/24'),
  ipv4Cidr('192.168.0.0/16'),
  ipv4Cidr('198.18.0.0/15'),
  ipv4Cidr('198.51.100.0/24'),
  ipv4Cidr('203.0.113.0/24'),
  ipv4Cidr('224.0.0.0/4'),
  ipv4Cidr('240.0.0.0/4'),
];

const BLOCKED_IPV6_RANGES: ParsedCidr[] = [
  ipv6Cidr('::/8'),
  ipv6Cidr('::/128'),
  ipv6Cidr('::1/128'),
  ipv6Cidr('64:ff9b:1::/48'),
  ipv6Cidr('100::/64'),
  ipv6Cidr('2001::/23'),
  ipv6Cidr('2001:db8::/32'),
  ipv6Cidr('2002::/16'),
  ipv6Cidr('3fff::/20'),
  ipv6Cidr('5f00::/16'),
  ipv6Cidr('fc00::/7'),
  ipv6Cidr('fec0::/10'),
  ipv6Cidr('fe80::/10'),
  ipv6Cidr('ff00::/8'),
];

const IPV4_MAPPED_PREFIX = ipv6Cidr('::ffff:0:0/96');
const NAT64_PREFIX = ipv6Cidr('64:ff9b::/96');
const IPV6_GLOBAL_UNICAST = ipv6Cidr('2000::/3');

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

  if (
    parsed.family === 6 &&
    !cidrContains(IPV6_GLOBAL_UNICAST, 6, parsed.value)
  ) {
    return `Address '${ip}' is outside the public IPv6 unicast range.`;
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

export interface SafeHeadFollowingRedirectsOptions {
  allowedPrivateCidrs?: string;
  lookup?: DnsLookupFn;
  signal?: AbortSignal;
  maxRedirects?: number;
  requireHttps?: boolean;
}

interface GuardedAgentConfig {
  allowedPrivateCidrs: string | undefined;
  lookup?: DnsLookupFn;
}

/**
 * Hygiene + IP-literal vetting for an operator-supplied URL. IP literals
 * never reach a DNS lookup hook, so they must be checked here; hostnames are
 * vetted at connect time by {@link createGuardedConnectOptions}.
 */
export function assertEgressUrlAllowed(
  target: string | URL,
  allowedPrivateCidrs?: string,
): URL {
  const url = validateEgressUrl(target);
  const bareHostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(bareHostname) !== 0) {
    const reason = checkAddressAllowed(
      bareHostname,
      parseCidrList(allowedPrivateCidrs),
    );

    if (reason !== null) {
      throw new SafeFetchViolationError(reason);
    }
  }

  return url;
}

/**
 * Resolve a destination and require every answer to be publicly routable.
 * Callers must still use a guarded Agent when they later connect.
 */
export async function assertEgressUrlResolvesPublic(
  target: string | URL,
  options: { lookup?: DnsLookupFn } = {},
): Promise<URL> {
  const url = assertEgressUrlAllowed(target);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) !== 0) return url;

  const connect = createGuardedConnectOptions({
    allowedPrivateCidrs: undefined,
    lookup: options.lookup,
  });
  await new Promise<void>((resolve, reject) => {
    connect.lookup(
      hostname,
      { all: true },
      (error: NodeJS.ErrnoException | null) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
  return url;
}

/**
 * undici `connect` options that vet and pin every DNS answer. Exported so
 * callers with their own Agent needs (e.g. the API's long-lived-stream proxy
 * dispatcher) can compose the guard with other Agent options.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createGuardedConnectOptions(config: GuardedAgentConfig): any {
  const allowed = parseCidrList(config.allowedPrivateCidrs);
  const lookup = config.lookup ?? nodeDnsLookup;

  return {
    lookup: (
      hostname: string,
      options: { all?: boolean } & Record<string, unknown>,
      callback: (
        error: NodeJS.ErrnoException | null,
        address: unknown,
        family?: number,
      ) => void,
    ) => {
      lookup(
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

          const rejected = results.find(
            (result) => checkAddressAllowed(result.address, allowed) !== null,
          );
          const vetted = rejected ? [] : results;

          if (vetted.length === 0) {
            const reason =
              results.length === 0
                ? `DNS for '${hostname}' returned no addresses.`
                : (checkAddressAllowed(
                    rejected?.address ?? results[0]!.address,
                    allowed,
                  ) ?? 'refused');

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
              })),
              undefined,
            );
          } else {
            callback(null, vetted[0]!.address, vetted[0]!.family);
          }
        },
      );
    },
  };
}

function createGuardedAgent(config: GuardedAgentConfig): Agent {
  return new Agent({ connect: createGuardedConnectOptions(config) });
}

const agentCache = new Map<string, Agent>();

function guardedAgentFor(config: GuardedAgentConfig): Agent {
  // Custom lookup functions are test-only; never cache those agents.
  if (config.lookup && config.lookup !== nodeDnsLookup) {
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
 * A `fetch`-shaped wrapper around {@link safeFetch} for callers that thread a
 * fetch implementation through protocol code (the MCP OAuth layer).
 */
export function createGuardedFetch(allowedPrivateCidrs?: string) {
  return (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> =>
    safeFetch(url, {
      allowedPrivateCidrs,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    });
}

/** One guarded request. Public helpers below decide redirect policy. */
async function safeFetchOnce(
  target: string | URL,
  options: SafeFetchOptions,
): Promise<Response> {
  const url = assertEgressUrlAllowed(target, options.allowedPrivateCidrs);

  const dispatcher = guardedAgentFor({
    allowedPrivateCidrs: options.allowedPrivateCidrs,
    lookup: options.lookup,
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

  return response as unknown as Response;
}

export async function safeHeadFollowingRedirects(
  target: string | URL,
  options: SafeHeadFollowingRedirectsOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 3;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new SafeFetchViolationError(
      'maxRedirects must be a non-negative integer.',
    );
  }

  let url = validateEgressUrl(target);
  for (let redirects = 0; ; redirects++) {
    if (options.requireHttps && url.protocol !== 'https:') {
      throw new SafeFetchViolationError(
        `'${url.toString()}' must use https, including redirect targets.`,
      );
    }

    const response = await safeFetchOnce(url, {
      allowedPrivateCidrs: options.allowedPrivateCidrs,
      lookup: options.lookup,
      signal: options.signal,
      method: 'HEAD',
    });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) {
      throw new SafeFetchViolationError(
        `'${url.toString()}' answered with a redirect without a Location header.`,
      );
    }
    if (redirects >= maxRedirects) {
      throw new SafeFetchViolationError(
        `'${url.toString()}' exceeded the ${maxRedirects}-redirect limit.`,
      );
    }
    url = validateEgressUrl(new URL(location, url));
  }
}

/** Fetch an operator-supplied URL with SSRF guards and refuse redirects. */
export async function safeFetch(
  target: string | URL,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const url = validateEgressUrl(target);
  const response = await safeFetchOnce(url, options);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new SafeFetchViolationError(
      `'${url.toString()}' answered with a redirect (${response.status}), ` +
        `which is refused for operator-supplied URLs.`,
    );
  }
  return response;
}

export const PUBLIC_URL_FETCH_MAX_REDIRECTS = 3;
export const PUBLIC_URL_FETCH_MAX_RESPONSE_BYTES = 5 * 1_024 * 1_024;
export const PUBLIC_URL_FETCH_DEFAULT_TIMEOUT_MS =
  PUBLIC_URL_FETCH_DEFAULT_TIMEOUT_SECONDS * 1_000;
export const PUBLIC_URL_FETCH_MAX_TIMEOUT_MS =
  PUBLIC_URL_FETCH_MAX_TIMEOUT_SECONDS * 1_000;
export const PUBLIC_URL_FETCH_MAX_HTML_CONVERSION_BYTES = 1_024 * 1_024;

export interface PublicUrlFetchOptions extends Partial<
  Pick<PublicUrlFetchInput, 'format' | 'timeout' | 'headers'>
> {
  signal?: AbortSignal;
}

interface PublicUrlFetchInternalOptions extends PublicUrlFetchOptions {
  /** Test-only DNS resolver override. */
  lookup?: DnsLookupFn;
  /** Test-only private fixture allowance. Never pass this from product code. */
  allowedPrivateCidrs?: string;
  /** Test-only non-default fixture port allowance. */
  allowNonDefaultPorts?: boolean;
  maxRedirects?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

function validatePublicUrl(
  target: string | URL,
  allowNonDefaultPorts = false,
): URL {
  const url = validateEgressUrl(target);

  if (url.port && !allowNonDefaultPorts) {
    throw new SafeFetchViolationError(
      'Public URL fetch only supports the default HTTP and HTTPS ports.',
    );
  }

  return url;
}

function isTextContentType(contentType: string): boolean {
  const mimeType = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType.endsWith('+json') ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+xml') ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-javascript'
  );
}

function resolveTextEncoding(
  contentType: string,
  mimeType: string,
  bytes: Uint8Array,
): string {
  let labels = contentType
    .split(';')
    .slice(1)
    .map((parameter) => parameter.trim())
    .filter((parameter) => /^charset\s*=/i.test(parameter))
    .map((parameter) =>
      parameter
        .slice(parameter.indexOf('=') + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .toLowerCase(),
    );

  if (labels.length === 0 && isHtmlContentType(mimeType)) {
    const prefix = new TextDecoder('windows-1252').decode(
      bytes.subarray(0, 1_024),
    );
    const metaCharset = prefix.match(
      /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([a-z0-9._:-]+)/i,
    )?.[1];
    if (metaCharset) labels = [metaCharset.toLowerCase()];
  }

  if (labels.length === 0) return 'utf-8';

  let encodings: string[];
  try {
    encodings = labels.map(
      (label) => new TextDecoder(label, { fatal: true }).encoding,
    );
  } catch {
    throw new SafeFetchViolationError(
      'Public URL response declares an unsupported charset.',
    );
  }

  if (new Set(encodings).size !== 1) {
    throw new SafeFetchViolationError(
      'Public URL response declares conflicting charsets.',
    );
  }

  return encodings[0]!;
}

function decodeText(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new SafeFetchViolationError(
      `Public URL response is not valid ${encoding} text.`,
    );
  }
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
): Promise<Uint8Array> {
  const advertisedLength = response.headers.get('content-length');
  if (advertisedLength) {
    const parsedLength = Number(advertisedLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxResponseBytes) {
      await response.body?.cancel();
      throw new SafeFetchViolationError('Public URL response is too large.');
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      byteCount += value.byteLength;
      if (byteCount > maxResponseBytes) {
        await reader.cancel();
        throw new SafeFetchViolationError('Public URL response is too large.');
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function extractTextFromHtml(html: string): string {
  let text = '';
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (
        skipDepth > 0 ||
        ['script', 'style', 'noscript', 'iframe', 'object', 'embed'].includes(
          name,
        )
      ) {
        skipDepth += 1;
      }
    },
    ontext(value) {
      if (skipDepth === 0) text += value;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth -= 1;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}

function convertHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  turndown.remove(['script', 'style', 'meta', 'link']);
  return turndown.turndown(html);
}

const PUBLIC_FETCH_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const FORBIDDEN_CALLER_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function normalizeCallerHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const entries = Object.entries(headers);
  if (entries.length > 20) {
    throw new SafeFetchViolationError(
      'Public URL fetch accepts at most 20 caller headers.',
    );
  }

  return Object.fromEntries(
    entries.map(([rawName, value]) => {
      const name = rawName.trim().toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
        throw new SafeFetchViolationError(
          'Public URL fetch received an invalid header name.',
        );
      }
      if (FORBIDDEN_CALLER_HEADERS.has(name)) {
        throw new SafeFetchViolationError(
          `Public URL fetch does not allow the '${name}' header.`,
        );
      }
      if (value.length > 8_192 || /[\r\n]/.test(value)) {
        throw new SafeFetchViolationError(
          `Public URL fetch received an invalid '${name}' header value.`,
        );
      }
      return [name, value];
    }),
  );
}

function isSensitiveCallerHeader(name: string): boolean {
  return (
    ['authorization', 'proxy-authorization', 'cookie', 'cookie2'].includes(
      name,
    ) ||
    /(?:^|[-_])(api[-_]?key|auth|credential|key|secret|token)(?:$|[-_])/i.test(
      name,
    )
  );
}

function stripCrossOriginSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveCallerHeader(name)),
  );
}

function acceptHeaderForFormat(
  format: NonNullable<PublicUrlFetchOptions['format']>,
): string {
  switch (format) {
    case 'markdown':
      return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1';
    case 'text':
      return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1';
    case 'html':
      return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1';
  }
}

function isImageContentType(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') &&
    mimeType !== 'image/svg+xml' &&
    mimeType !== 'image/vnd.fastbidsheet'
  );
}

function isHtmlContentType(mimeType: string): boolean {
  return mimeType === 'text/html' || mimeType === 'application/xhtml+xml';
}

/**
 * Public fetch for agent tools. It keeps OpenCode's useful format, image,
 * timeout, and compatibility behavior while adding Roomote's public-only
 * address policy, pinned DNS answers, and per-hop redirect validation.
 */
export async function fetchPublicUrl(
  target: string | URL,
  options: PublicUrlFetchOptions = {},
): Promise<PublicUrlFetchResult> {
  return fetchPublicUrlInternal(target, options);
}

/** @internal Controlled-fixture hook; product callers must use fetchPublicUrl. */
export async function fetchPublicUrlForTesting(
  target: string | URL,
  options: PublicUrlFetchInternalOptions,
): Promise<PublicUrlFetchResult> {
  return fetchPublicUrlInternal(target, options);
}

async function fetchPublicUrlInternal(
  target: string | URL,
  options: PublicUrlFetchInternalOptions,
): Promise<PublicUrlFetchResult> {
  const maxRedirects = options.maxRedirects ?? PUBLIC_URL_FETCH_MAX_REDIRECTS;
  const maxResponseBytes =
    options.maxResponseBytes ?? PUBLIC_URL_FETCH_MAX_RESPONSE_BYTES;
  const timeoutSeconds =
    options.timeout ?? PUBLIC_URL_FETCH_DEFAULT_TIMEOUT_MS / 1_000;
  const timeoutMs = options.timeoutMs ?? Math.ceil(timeoutSeconds * 1_000);
  const format = options.format ?? 'markdown';

  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new SafeFetchViolationError(
      'maxRedirects must be a non-negative integer.',
    );
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new SafeFetchViolationError(
      'maxResponseBytes must be a positive integer.',
    );
  }
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PUBLIC_URL_FETCH_MAX_TIMEOUT_MS
  ) {
    throw new SafeFetchViolationError(
      'Public URL fetch timeout must be greater than 0 and at most 120 seconds.',
    );
  }

  let callerHeaders = normalizeCallerHeaders(options.headers);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  let url = validatePublicUrl(target, options.allowNonDefaultPorts);

  for (let redirects = 0; ; redirects++) {
    const defaultHeaders = {
      accept: acceptHeaderForFormat(format),
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': PUBLIC_FETCH_BROWSER_USER_AGENT,
    };
    let response = await safeFetchOnce(url, {
      allowedPrivateCidrs: options.allowedPrivateCidrs,
      lookup: options.lookup,
      signal,
      method: 'GET',
      headers: { ...defaultHeaders, ...callerHeaders },
    });

    if (
      response.status === 403 &&
      response.headers.get('cf-mitigated') === 'challenge'
    ) {
      await response.body?.cancel();
      response = await safeFetchOnce(url, {
        allowedPrivateCidrs: options.allowedPrivateCidrs,
        lookup: options.lookup,
        signal,
        method: 'GET',
        headers: {
          ...defaultHeaders,
          ...callerHeaders,
          'user-agent': 'Roomote-Public-URL-Fetch/1.0',
        },
      });
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) {
        throw new SafeFetchViolationError(
          'Public URL returned a redirect without a Location header.',
        );
      }
      if (redirects >= maxRedirects) {
        throw new SafeFetchViolationError(
          `Public URL exceeded the ${maxRedirects}-redirect limit.`,
        );
      }
      const nextUrl = validatePublicUrl(
        new URL(location, url),
        options.allowNonDefaultPorts,
      );
      if (nextUrl.origin !== url.origin) {
        callerHeaders = stripCrossOriginSensitiveHeaders(callerHeaders);
      }
      url = nextUrl;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new SafeFetchViolationError(
        `Public URL returned HTTP status ${response.status}.`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const mimeType = contentType.split(';', 1)[0]!.trim().toLowerCase();
    if (isImageContentType(mimeType)) {
      const bytes = await readBoundedBody(response, maxResponseBytes);
      return {
        kind: 'image',
        url: url.toString(),
        status: response.status,
        contentType,
        mimeType,
        data: Buffer.from(bytes).toString('base64'),
        size: bytes.byteLength,
      };
    }

    if (!isTextContentType(contentType)) {
      await response.body?.cancel();
      throw new SafeFetchViolationError(
        'Public URL response is not a supported text content type.',
      );
    }

    const bytes = await readBoundedBody(response, maxResponseBytes);
    if (
      isHtmlContentType(mimeType) &&
      format === 'markdown' &&
      bytes.byteLength > PUBLIC_URL_FETCH_MAX_HTML_CONVERSION_BYTES
    ) {
      throw new SafeFetchViolationError(
        'Public URL response is too large to convert to markdown; request text or html format instead.',
      );
    }
    const encoding = resolveTextEncoding(contentType, mimeType, bytes);
    const content = decodeText(bytes, encoding);
    const text = isHtmlContentType(mimeType)
      ? format === 'markdown'
        ? convertHtmlToMarkdown(content)
        : format === 'text'
          ? extractTextFromHtml(content)
          : content
      : content;

    return {
      kind: 'text',
      url: url.toString(),
      status: response.status,
      contentType,
      format,
      text,
    };
  }
}
