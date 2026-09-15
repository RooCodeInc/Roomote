import { z } from 'zod';

import {
  SESSION_EGRESS_READ_METHODS,
  sessionEgressAllowedMethodsSchema,
  sessionEgressHeaderNameSchema,
  type SessionEgressMethod,
} from './session-egress';

export const SESSION_SECRET_TOOLS_EXPERIMENT_KEY =
  'session_secret_tools_enabled' as const;

export function isSessionSecretToolsExperimentEnabled(
  metadata: unknown,
): boolean {
  return (
    Boolean(metadata) &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[
      SESSION_SECRET_TOOLS_EXPERIMENT_KEY
    ] === true
  );
}

const sessionSecretPrepareFields = {
  label: z.string().trim().min(1).max(80),
  origin: z.string().min(1).max(2048),
  headerName: sessionEgressHeaderNameSchema,
  ttlHours: z.number().int().min(1).max(720).default(24),
  /**
   * Methods ordinary clients may use through the egress gateway. Omitting
   * this keeps the grant read-only; anything beyond GET/HEAD must be
   * acknowledged again by the owner when the key is entered.
   */
  allowedMethods: sessionEgressAllowedMethodsSchema.default([
    ...SESSION_EGRESS_READ_METHODS,
  ]),
};

export const sessionSecretPrepareSchema = z
  .object({
    ...sessionSecretPrepareFields,
    headerPrefix: z.enum(['', 'Bearer ', 'Basic ', 'Token ']),
  })
  .strict();

// Provider schemas cannot contain empty enum members. Omission maps to the
// persisted empty-string representation before entering the shared runtime.
export const sessionSecretPrepareToolSchema = z
  .object({
    ...sessionSecretPrepareFields,
    headerPrefix: z
      .enum(['Bearer ', 'Basic ', 'Token '])
      .optional()
      .transform((prefix) => prefix ?? ''),
  })
  .strict();

export const sessionSecretCreateSchema = z
  .object({
    pendingRef: z.string().uuid(),
    secret: z.string().min(8).max(4096),
    /**
     * Required, and required to match the prepared policy exactly, whenever
     * the prepared approval allows a write method. A client that does not
     * show and echo the method policy cannot approve a write-capable grant.
     */
    allowedMethods: sessionEgressAllowedMethodsSchema.optional(),
  })
  .strict();

export const sessionSecretRevokeSchema = z
  .object({
    secretRef: z.string().uuid(),
  })
  .strict();

/**
 * @deprecated Mediated Session-grant requests (`request_with_session_secret`
 * / `integration_request` with a `session:` ID) are a GET/HEAD-only
 * compatibility path, not the required resource path. Grants are meant to be
 * used by ordinary HTTP clients at the real service URL through the session
 * egress gateway; see `session-egress.ts`.
 */
export const sessionSecretRequestSchema = z
  .object({
    secretRef: z.string().uuid(),
    method: z.enum(['GET', 'HEAD']),
    path: z.string().min(1).max(2048),
    accept: z.enum(['application/json', 'text/plain']).optional(),
    body: z
      .literal('')
      .nullish()
      .describe(
        'GET/HEAD have no body. Omit, use null, or use an empty string.',
      ),
  })
  .strict();

export type SessionSecretCreate = z.infer<typeof sessionSecretCreateSchema>;
export type SessionSecretPrepare = z.infer<typeof sessionSecretPrepareSchema>;
export type SessionSecretRequest = z.infer<typeof sessionSecretRequestSchema>;

export interface SessionSecretMetadata {
  secretRef: string;
  label: string;
  origin: string;
  headerName: SessionSecretPrepare['headerName'];
  headerPrefix: SessionSecretPrepare['headerPrefix'];
  allowedMethods: SessionEgressMethod[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface SessionSecretPendingMetadata extends Omit<
  SessionSecretMetadata,
  'secretRef' | 'revokedAt'
> {
  pendingRef: string;
}

export interface SessionSecretApprovals {
  pending: SessionSecretPendingMetadata[];
  secrets: SessionSecretMetadata[];
}

/** @deprecated See {@link sessionSecretRequestSchema}. */
export type SessionSecretRequestResult =
  | { success: true; status: number; body: string }
  | { success: false; error: 'Secret request unavailable' };
