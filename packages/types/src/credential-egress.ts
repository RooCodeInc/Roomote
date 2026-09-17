import { z } from 'zod';

/**
 * Credential egress control plane: the controller -> API contract behind
 * ordinary HTTP clients that call approved services through the API-side
 * credential-substituting proxy.
 *
 * Workloads (attached runs) only ever hold opaque substitute tokens. The
 * real credential is resolved by the API, per request, and injected on its
 * way to the approved origin. Nothing in this module is a model tool schema;
 * none of these payloads is accepted from a sandbox or a Fast tool argument.
 *
 * Full contract: apps/api/src/handlers/credential-egress/CONTRACT.md
 */

export const CREDENTIAL_EGRESS_CONTROL_PLANE_PATH =
  '/api/internal/credential-egress';

/** Substitute tokens carry a scannable prefix so leak scans can tell them from real keys. */
export const CREDENTIAL_EGRESS_SUBSTITUTE_PREFIX = 'rses_';

export const CREDENTIAL_EGRESS_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;
export const credentialEgressMethodSchema = z.enum(CREDENTIAL_EGRESS_METHODS);

export const CREDENTIAL_EGRESS_HEADER_NAME_MAX_LENGTH = 64;

/**
 * Headers that can never carry a Session credential: they shape the request
 * itself, route it, frame its body, or carry other credentials, so injecting
 * a key there would change what the origin sees rather than authenticate it.
 */
const RESERVED_CREDENTIAL_HEADER_NAMES = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'cookie2',
  'date',
  'expect',
  'forwarded',
  'host',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'keep-alive',
  'location',
  'origin',
  'pragma',
  'range',
  'referer',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'www-authenticate',
  'x-real-ip',
]);

/**
 * Any RFC 7230 token can name the header that carries a grant's key:
 * `authorization`, `x-api-key`, `api-key`, or a service-specific name such as
 * `private-token` or `x-shopify-access-token`. Names compare lowercase.
 */
export function isCredentialEgressCredentialHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.length <= CREDENTIAL_EGRESS_HEADER_NAME_MAX_LENGTH &&
    /^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower) &&
    !RESERVED_CREDENTIAL_HEADER_NAMES.has(lower) &&
    !lower.startsWith('proxy-') &&
    !lower.startsWith('x-forwarded-') &&
    !lower.startsWith('sec-')
  );
}

export const credentialEgressHeaderNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isCredentialEgressCredentialHeaderName, {
    message: 'unsupported credential header',
  });
export type CredentialEgressMethod = z.infer<
  typeof credentialEgressMethodSchema
>;

/** Grants prepared before method policy existed, and grants that omit it, stay read-only. */
export const CREDENTIAL_EGRESS_READ_METHODS = ['GET', 'HEAD'] as const;

export const credentialEgressAllowedMethodsSchema = z
  .array(credentialEgressMethodSchema)
  .min(1)
  .max(CREDENTIAL_EGRESS_METHODS.length)
  .refine((methods) => new Set(methods).size === methods.length)
  .transform((methods) =>
    CREDENTIAL_EGRESS_METHODS.filter((method) => methods.includes(method)),
  );

export function isReadOnlyMethodPolicy(
  methods: readonly CredentialEgressMethod[],
): boolean {
  return methods.every((method) =>
    (CREDENTIAL_EGRESS_READ_METHODS as readonly string[]).includes(method),
  );
}

const connectorIdentitySchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[\x21-\x7e]+$/);

/** Validated for shape so the gateway cannot pass junk, but never persisted or logged. */
const requestPathSchema = z
  .string()
  .max(8192)
  .regex(/^\/[^\s\u0000-\u001f\u007f]*$/);

export const credentialEgressWorkloadRegisterSchema = z
  .object({
    runId: z.number().int().positive(),
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    connectorIdentity: connectorIdentitySchema,
    leaseSeconds: z.number().int().min(60).max(86_400).default(3_600),
  })
  .strict();

export const credentialEgressWorkloadLeaseSchema = z
  .object({
    leaseSeconds: z.number().int().min(60).max(86_400).default(3_600),
  })
  .strict();

export const CREDENTIAL_EGRESS_TERMINATION_REASONS = [
  'stopped',
  'completed',
  'failed',
  'provision_failed',
  'resumed',
  'actor_changed',
  'detached',
  'orphaned',
  'cleanup',
] as const;

export const credentialEgressWorkloadTerminateSchema = z
  .object({
    reason: z.enum(CREDENTIAL_EGRESS_TERMINATION_REASONS).default('cleanup'),
  })
  .strict();

export const CREDENTIAL_EGRESS_PHASES = [
  'request',
  'response',
  'stream',
] as const;
export type CredentialEgressPhase = (typeof CREDENTIAL_EGRESS_PHASES)[number];

const substituteSchema = z
  .string()
  .min(CREDENTIAL_EGRESS_SUBSTITUTE_PREFIX.length + 32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Public prefix of the API-side substitution proxy. A workload points an
 * ordinary HTTP client at `<api origin>/api/credential-egress` as the base URL
 * of every approved service and presents the service's substitute as its
 * credential; the substitute alone names the grant, so the API rewrites the
 * request onto that grant's approved origin and injects the real credential.
 */
export const CREDENTIAL_EGRESS_PROXY_PATH = '/api/credential-egress';

/**
 * The one base URL a workload uses for every approved service: the dedicated
 * proxy hostname when the deployment has one, otherwise the API origin plus
 * the proxy path. Workloads never learn which form they were given.
 */
export function credentialEgressProxyBaseUrl(
  apiBaseUrl: string,
  proxyHost?: string | null,
): string {
  if (proxyHost) return `https://${proxyHost}`;
  let end = apiBaseUrl.length;
  while (end > 0 && apiBaseUrl[end - 1] === '/') end--;
  return `${apiBaseUrl.slice(0, end)}${CREDENTIAL_EGRESS_PROXY_PATH}`;
}

/**
 * Authorization input for the API-side proxy. The substitute alone names the
 * grant: the API is the only party between the workload and the origin.
 */
export const credentialEgressProxyAuthorizeSchema = z
  .object({
    substitute: substituteSchema,
    method: credentialEgressMethodSchema,
    path: requestPathSchema,
    phase: z.enum(CREDENTIAL_EGRESS_PHASES).default('request'),
    authorizationId: z.string().uuid().optional(),
  })
  .strict();

export type CredentialEgressWorkloadRegister = z.infer<
  typeof credentialEgressWorkloadRegisterSchema
>;
export type CredentialEgressWorkloadLease = z.infer<
  typeof credentialEgressWorkloadLeaseSchema
>;
export type CredentialEgressWorkloadTerminate = z.infer<
  typeof credentialEgressWorkloadTerminateSchema
>;
export type CredentialEgressProxyAuthorize = z.infer<
  typeof credentialEgressProxyAuthorizeSchema
>;

export interface CredentialEgressGrantPolicy {
  secretRef: string;
  label: string;
  /** Exact approved HTTPS origin, e.g. `https://api.example.com` or `https://host:8443`. */
  origin: string;
  /** Lowercase header that carries the key at the origin; see `isCredentialEgressCredentialHeaderName`. */
  headerName: string;
  /** A scheme is only meaningful on `authorization`; other headers carry the bare key. */
  headerPrefix: '' | 'Bearer ' | 'Basic ' | 'Token ';
  allowedMethods: CredentialEgressMethod[];
  /** Null: the grant is kept until revoked. */
  expiresAt: string | null;
}

/** Returned exactly once to the trusted controller; the API stores only a hash. */
export interface CredentialEgressSubstituteIssue extends CredentialEgressGrantPolicy {
  substitute: string;
}

export interface CredentialEgressWorkloadRegistration {
  workloadId: string;
  sessionId: string;
  generation: number;
  expiresAt: string;
  substitutes: CredentialEgressSubstituteIssue[];
}

export const CREDENTIAL_EGRESS_DENIAL_REASONS = [
  /** Body failed schema validation. */
  'malformed',
  /** No live substitute matches the presented token hash. */
  'unknown_substitute',
  /** Historical (connector gateway): token bound to another workload or identity. */
  'workload_mismatch',
  /** Workload terminated or its lease expired. */
  'workload_inactive',
  /** Token was minted for an older generation of this workload. */
  'stale_generation',
  'grant_revoked',
  'grant_expired',
  /** Owner removed, Session archived/reowned, run detached, actor changed, run finished. */
  'session_unavailable',
  /** Host or port differs from the approved origin. */
  'destination_mismatch',
  'method_not_allowed',
] as const;
export type CredentialEgressDenialReason =
  (typeof CREDENTIAL_EGRESS_DENIAL_REASONS)[number];

export type CredentialEgressAuthorization =
  | {
      allowed: true;
      authorizationId: string;
      workloadId: string;
      generation: number;
      sessionId: string;
      secretRef: string;
      /**
       * Earliest of the grant expiry and the workload lease expiry; the
       * proxy must not keep a response open past it.
       */
      expiresAt: string;
      /**
       * Present only on the `request` phase. The proxy injects this and
       * discards it after the exchange; it is never cached across requests.
       */
      credential?: {
        headerName: CredentialEgressGrantPolicy['headerName'];
        headerPrefix: CredentialEgressGrantPolicy['headerPrefix'];
        value: string;
      };
    }
  | { allowed: false; reason: CredentialEgressDenialReason };

export const CREDENTIAL_EGRESS_REVOCATION_KINDS = [
  'workload',
  'generation',
  'grant',
] as const;
export type CredentialEgressRevocationKind =
  (typeof CREDENTIAL_EGRESS_REVOCATION_KINDS)[number];

/**
 * Workload delivery contract (controller -> worker launcher env). The worker
 * captures these at startup, scrubs them from its own process env, and hands
 * task processes the proxy base URL, a nonsecret service manifest, and one
 * substitute env var per approved service. Nothing here is a real credential.
 */
export const CREDENTIAL_EGRESS_WORKLOAD_ENV = {
  /** Wait for the controller's post-bootstrap verified network admission. */
  BOOTSTRAP_REQUIRED: 'ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_REQUIRED',
  BOOTSTRAP_NONCE: 'ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_NONCE',
  /** JSON `CredentialEgressWorkloadServiceManifestEntry[]`; never contains token values. */
  SERVICES: 'ROOMOTE_CREDENTIAL_EGRESS_SERVICES',
  /**
   * The one base URL every approved service is called through
   * (`<api origin>/api/credential-egress`, or the deployment's dedicated proxy
   * host). Nonsecret; delivered next to the substitutes.
   */
  BASE_URL: 'ROOMOTE_SERVICE_BASE_URL',
} as const;

/** Substitute tokens are delivered as `ROOMOTE_SERVICE_TOKEN_<LABEL_SLUG>`. */
export const CREDENTIAL_EGRESS_SERVICE_TOKEN_ENV_PREFIX =
  'ROOMOTE_SERVICE_TOKEN_';

export interface CredentialEgressWorkloadServiceManifestEntry extends CredentialEgressGrantPolicy {
  /** The env var that carries this service's substitute token. */
  envName: string;
  /**
   * Call this instead of `origin`, with the substitute as the credential; the
   * API forwards to `origin`.
   */
  baseUrl?: string;
}

export function credentialEgressServiceTokenEnvName(label: string): string {
  const normalized = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === '_') start += 1;
  while (end > start && normalized[end - 1] === '_') end -= 1;
  const slug = normalized.slice(start, end);
  const safe =
    slug === '' ? 'SERVICE' : /^[0-9]/.test(slug) ? `_${slug}` : slug;
  return `${CREDENTIAL_EGRESS_SERVICE_TOKEN_ENV_PREFIX}${safe.slice(0, 96)}`;
}

/**
 * Split issued substitutes into the secret env map and the nonsecret
 * manifest. Label collisions get a numeric suffix so no token silently
 * overwrites another.
 */
export function buildCredentialEgressServiceTokenEnv(
  substitutes: readonly CredentialEgressSubstituteIssue[],
  options: { baseUrl?: string } = {},
): {
  tokens: Record<string, string>;
  manifest: CredentialEgressWorkloadServiceManifestEntry[];
} {
  const tokens: Record<string, string> = {};
  const manifest: CredentialEgressWorkloadServiceManifestEntry[] = [];
  for (const issue of substitutes) {
    const base = credentialEgressServiceTokenEnvName(issue.label);
    let envName = base;
    for (let n = 2; envName in tokens; n += 1) envName = `${base}_${n}`;
    tokens[envName] = issue.substitute;
    const { substitute: _omitted, ...policy } = issue;
    manifest.push({
      ...policy,
      envName,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
  }
  return { tokens, manifest };
}

export function isCredentialEgressWorkloadEnvKey(key: string): boolean {
  return (
    key.startsWith(CREDENTIAL_EGRESS_SERVICE_TOKEN_ENV_PREFIX) ||
    (Object.values(CREDENTIAL_EGRESS_WORKLOAD_ENV) as string[]).includes(key)
  );
}
