import { z } from 'zod';

/**
 * Session egress control plane: the gateway -> API and controller -> API
 * contract behind ordinary HTTP clients that talk to real service URLs
 * through a credential-substituting egress gateway.
 *
 * Workloads (attached runs) only ever hold opaque substitute tokens. The
 * real credential is resolved here, per request, for the gateway alone.
 * Nothing in this module is a model tool schema; none of these payloads is
 * accepted from a sandbox or a Fast tool argument.
 *
 * Full contract: apps/api/src/handlers/session-egress/CONTRACT.md
 */

export const SESSION_EGRESS_CONTROL_PLANE_PATH = '/api/internal/session-egress';

/** Substitute tokens carry a scannable prefix so leak scans can tell them from real keys. */
export const SESSION_EGRESS_SUBSTITUTE_PREFIX = 'rses_';

export const SESSION_EGRESS_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;
export const sessionEgressMethodSchema = z.enum(SESSION_EGRESS_METHODS);
export type SessionEgressMethod = z.infer<typeof sessionEgressMethodSchema>;

/** Grants prepared before method policy existed, and grants that omit it, stay read-only. */
export const SESSION_EGRESS_READ_METHODS = ['GET', 'HEAD'] as const;

export const sessionEgressAllowedMethodsSchema = z
  .array(sessionEgressMethodSchema)
  .min(1)
  .max(SESSION_EGRESS_METHODS.length)
  .refine((methods) => new Set(methods).size === methods.length)
  .transform((methods) =>
    SESSION_EGRESS_METHODS.filter((method) => methods.includes(method)),
  );

export function isReadOnlyMethodPolicy(
  methods: readonly SessionEgressMethod[],
): boolean {
  return methods.every((method) =>
    (SESSION_EGRESS_READ_METHODS as readonly string[]).includes(method),
  );
}

const connectorIdentitySchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[\x21-\x7e]+$/);

/**
 * Hostnames only: the gateway dials by name and pins the vetted address.
 * Literal IPs, credentials, ports inside the host, and non-ASCII are rejected.
 */
const destinationHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

/** Validated for shape so the gateway cannot pass junk, but never persisted or logged. */
const requestPathSchema = z
  .string()
  .max(8192)
  .regex(/^\/[^\s\u0000-\u001f\u007f]*$/);

export const sessionEgressWorkloadRegisterSchema = z
  .object({
    runId: z.number().int().positive(),
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    connectorIdentity: connectorIdentitySchema,
    leaseSeconds: z.number().int().min(60).max(86_400).default(3_600),
  })
  .strict();

export const sessionEgressWorkloadLeaseSchema = z
  .object({
    leaseSeconds: z.number().int().min(60).max(86_400).default(3_600),
  })
  .strict();

export const SESSION_EGRESS_TERMINATION_REASONS = [
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

export const sessionEgressWorkloadTerminateSchema = z
  .object({
    reason: z.enum(SESSION_EGRESS_TERMINATION_REASONS).default('cleanup'),
  })
  .strict();

export const SESSION_EGRESS_PHASES = ['request', 'response', 'stream'] as const;
export type SessionEgressPhase = (typeof SESSION_EGRESS_PHASES)[number];

export const sessionEgressAuthorizeSchema = z
  .object({
    workloadId: z.string().uuid(),
    connectorIdentity: connectorIdentitySchema,
    substitute: z
      .string()
      .min(SESSION_EGRESS_SUBSTITUTE_PREFIX.length + 32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    destination: z
      .object({
        host: destinationHostSchema,
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    method: sessionEgressMethodSchema,
    path: requestPathSchema,
    phase: z.enum(SESSION_EGRESS_PHASES).default('request'),
    /**
     * Correlates the request, response, and stream checks of one HTTP
     * exchange in the audit trail. Minted by the API when omitted. Caller-
     * controlled correlation only: never authority, uniqueness, or proof
     * that a previous phase succeeded.
     */
    authorizationId: z.string().uuid().optional(),
  })
  .strict();

export const sessionEgressRevocationsQuerySchema = z
  .object({
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export type SessionEgressWorkloadRegister = z.infer<
  typeof sessionEgressWorkloadRegisterSchema
>;
export type SessionEgressWorkloadLease = z.infer<
  typeof sessionEgressWorkloadLeaseSchema
>;
export type SessionEgressWorkloadTerminate = z.infer<
  typeof sessionEgressWorkloadTerminateSchema
>;
export type SessionEgressAuthorize = z.infer<
  typeof sessionEgressAuthorizeSchema
>;
export type SessionEgressRevocationsQuery = z.infer<
  typeof sessionEgressRevocationsQuerySchema
>;

export interface SessionEgressGrantPolicy {
  secretRef: string;
  label: string;
  /** Exact approved HTTPS origin, e.g. `https://api.example.com` or `https://host:8443`. */
  origin: string;
  headerName: 'authorization' | 'x-api-key' | 'api-key';
  headerPrefix: '' | 'Bearer ' | 'Basic ' | 'Token ';
  allowedMethods: SessionEgressMethod[];
  expiresAt: string;
}

/** Returned exactly once to the trusted controller; the API stores only a hash. */
export interface SessionEgressSubstituteIssue extends SessionEgressGrantPolicy {
  substitute: string;
}

export interface SessionEgressWorkloadRegistration {
  workloadId: string;
  sessionId: string;
  generation: number;
  expiresAt: string;
  substitutes: SessionEgressSubstituteIssue[];
}

export const SESSION_EGRESS_DENIAL_REASONS = [
  /** Body failed schema validation. */
  'malformed',
  /** No live substitute matches the presented token hash. */
  'unknown_substitute',
  /** Token exists but belongs to another workload, generation, or connector identity. */
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
export type SessionEgressDenialReason =
  (typeof SESSION_EGRESS_DENIAL_REASONS)[number];

export type SessionEgressAuthorization =
  | {
      allowed: true;
      authorizationId: string;
      workloadId: string;
      generation: number;
      sessionId: string;
      secretRef: string;
      /**
       * Earliest of the grant expiry and the workload lease expiry; the
       * gateway must not keep a stream open past it.
       */
      expiresAt: string;
      /**
       * Present only on the `request` phase. The gateway injects this and
       * discards it after the exchange; it is never cached across requests.
       */
      credential?: {
        headerName: SessionEgressGrantPolicy['headerName'];
        headerPrefix: SessionEgressGrantPolicy['headerPrefix'];
        value: string;
      };
    }
  | { allowed: false; reason: SessionEgressDenialReason };

export const SESSION_EGRESS_REVOCATION_KINDS = [
  'workload',
  'generation',
  'grant',
] as const;
export type SessionEgressRevocationKind =
  (typeof SESSION_EGRESS_REVOCATION_KINDS)[number];

export interface SessionEgressRevocationEvent {
  id: number;
  kind: SessionEgressRevocationKind;
  workloadId: string | null;
  secretRef: string | null;
  /** For `generation`, the first generation that remains valid. */
  generation: number | null;
  createdAt: string;
}

export interface SessionEgressRevocationFeed {
  events: SessionEgressRevocationEvent[];
  /** Pass back as `after` on the next poll. */
  cursor: number;
}
