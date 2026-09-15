import { z } from 'zod';

import {
  CREDENTIAL_EGRESS_READ_METHODS,
  credentialEgressAllowedMethodsSchema,
  credentialEgressHeaderNameSchema,
  type CredentialEgressMethod,
} from './credential-egress';

export const SERVICE_CREDENTIAL_TOOLS_EXPERIMENT_KEY =
  'integration_keys_enabled' as const;

export function isServiceCredentialToolsExperimentEnabled(
  metadata: unknown,
): boolean {
  return (
    Boolean(metadata) &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[
      SERVICE_CREDENTIAL_TOOLS_EXPERIMENT_KEY
    ] === true
  );
}

/** One year; an omitted lifetime keeps the integration until it is revoked. */
export const SERVICE_CREDENTIAL_MAX_LIFETIME_HOURS = 8760;
/** How long a prepared approval waits for the human to enter the key. */
export const SERVICE_CREDENTIAL_APPROVAL_WINDOW_HOURS = 24;

const serviceCredentialPrepareFields = {
  label: z.string().trim().min(1).max(80),
  origin: z.string().min(1).max(2048),
  headerName: credentialEgressHeaderNameSchema,
  /** Omitted: the integration is kept until revoked. */
  lifetimeHours: z
    .number()
    .int()
    .min(1)
    .max(SERVICE_CREDENTIAL_MAX_LIFETIME_HOURS)
    .optional(),
  /**
   * Methods ordinary clients may use through the egress gateway. Omitting
   * this keeps the grant read-only; anything beyond GET/HEAD must be
   * acknowledged again by the owner when the key is entered.
   */
  allowedMethods: credentialEgressAllowedMethodsSchema.default([
    ...CREDENTIAL_EGRESS_READ_METHODS,
  ]),
};

export const serviceCredentialPrepareSchema = z
  .object({
    ...serviceCredentialPrepareFields,
    headerPrefix: z.enum(['', 'Bearer ', 'Basic ', 'Token ']),
  })
  .strict();

// Provider schemas cannot contain empty enum members. Omission maps to the
// persisted empty-string representation before entering the shared runtime.
export const serviceCredentialPrepareToolSchema = z
  .object({
    ...serviceCredentialPrepareFields,
    headerPrefix: z
      .enum(['Bearer ', 'Basic ', 'Token '])
      .optional()
      .transform((prefix) => prefix ?? ''),
  })
  .strict();

export const serviceCredentialCreateSchema = z
  .object({
    pendingRef: z.string().uuid(),
    secret: z.string().min(8).max(4096),
    /**
     * Required, and required to match the prepared policy exactly, whenever
     * the prepared approval allows a write method. A client that does not
     * show and echo the method policy cannot approve a write-capable grant.
     */
    allowedMethods: credentialEgressAllowedMethodsSchema.optional(),
  })
  .strict();

export const serviceCredentialRevokeSchema = z
  .object({
    secretRef: z.string().uuid(),
  })
  .strict();

/**
 * An integration added from Settings: the human supplies the policy and the
 * key together, so no prepared approval or method echo is involved.
 */
export const integrationCreateSchema = z
  .object({
    ...serviceCredentialPrepareFields,
    headerPrefix: z.enum(['', 'Bearer ', 'Basic ', 'Token ']),
    secret: z.string().min(8).max(4096),
  })
  .strict();

/**
 * @deprecated Mediated integration-key requests (`request_with_integration_key`
 * / `integration_request` with a `session:` ID) are a GET/HEAD-only
 * compatibility path, not the required resource path. Grants are meant to be
 * used by ordinary HTTP clients at the real service URL through the session
 * egress gateway; see `credential-egress.ts`.
 */
export const serviceCredentialRequestSchema = z
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

export type ServiceCredentialCreate = z.infer<
  typeof serviceCredentialCreateSchema
>;
export type ServiceCredentialPrepare = z.infer<
  typeof serviceCredentialPrepareSchema
>;
export type IntegrationCreate = z.infer<typeof integrationCreateSchema>;
export type ServiceCredentialRequest = z.infer<
  typeof serviceCredentialRequestSchema
>;

export interface ServiceCredentialMetadata {
  secretRef: string;
  label: string;
  origin: string;
  headerName: ServiceCredentialPrepare['headerName'];
  headerPrefix: ServiceCredentialPrepare['headerPrefix'];
  allowedMethods: CredentialEgressMethod[];
  /** Null: kept until revoked. */
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ServiceCredentialPendingMetadata extends Omit<
  ServiceCredentialMetadata,
  'secretRef' | 'revokedAt' | 'expiresAt'
> {
  pendingRef: string;
  /** How long the integration will live once the key is entered; null keeps it until revoked. */
  lifetimeHours: number | null;
  /** When this approval stops accepting a key. */
  expiresAt: string;
}

export interface ServiceCredentialApprovals {
  pending: ServiceCredentialPendingMetadata[];
  secrets: ServiceCredentialMetadata[];
}

/** @deprecated See {@link serviceCredentialRequestSchema}. */
export type ServiceCredentialRequestResult =
  | { success: true; status: number; body: string }
  | { success: false; error: 'Secret request unavailable' };

/**
 * Wraps the instruction Roomote injects into the Session turn it sends after
 * the owner saves an integration key. The Session transcript hides every such
 * block and shows the text that follows it.
 */
export const INTEGRATION_SAVED_TAG = 'integration_saved' as const;

const INTEGRATION_SAVED_BLOCK =
  /<integration_saved>[\s\S]*?<\/integration_saved>\s*/gu;

export function hasIntegrationSavedBlock(text: string): boolean {
  return text.includes(`<${INTEGRATION_SAVED_TAG}>`);
}

export function stripIntegrationSavedBlocks(text: string): string {
  return text.replace(INTEGRATION_SAVED_BLOCK, '').trim();
}
