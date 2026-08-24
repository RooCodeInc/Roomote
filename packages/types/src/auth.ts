import { z } from 'zod';

/**
 * RunTokenPayload
 */

export const runTokenPayloadSchema = z.object({
  iss: z.string().min(1, 'Issuer (iss) is required'),
  sub: z.string().min(1, 'Subject (sub) is required'), // Run ID
  exp: z.number().int().positive('Expiration (exp) must be a positive integer'),
  iat: z.number().int().positive('Issued at (iat) must be a positive integer'),
  nbf: z.number().int().positive('Not before (nbf) must be a positive integer'),
  v: z.literal(1, { errorMap: () => ({ message: 'Version must be 1' }) }),
  r: z.object({
    // Absent user claim means the run runs as the deployment service
    // principal (automation-initiated work with no human driver).
    u: z.string().min(1, 'User ID must be non-empty when present').optional(),
    t: z.literal('run', {
      errorMap: () => ({ message: 'Token type must be "run"' }),
    }),
  }),
});

export type RunTokenPayload = z.infer<typeof runTokenPayloadSchema>;

export const automationTokenPayloadSchema = z.object({
  iss: z.string().min(1, 'Issuer (iss) is required'),
  sub: z.string().uuid('Subject (sub) must be an automation run ID'),
  exp: z.number().int().positive('Expiration (exp) must be a positive integer'),
  iat: z.number().int().positive('Issued at (iat) must be a positive integer'),
  nbf: z.number().int().positive('Not before (nbf) must be a positive integer'),
  v: z.literal(1, { errorMap: () => ({ message: 'Version must be 1' }) }),
  r: z.object({
    t: z.literal('automation'),
    p: z.literal('deployment'),
    pv: z.number().int().positive(),
    l: z.string().min(1),
  }),
});

export type AutomationTokenPayload = z.infer<
  typeof automationTokenPayloadSchema
>;

export interface AutomationTokenContext {
  automationRunId: string;
  leaseOwner: string;
  policyVersion: number;
  principal: 'deployment';
  tokenType: 'automation';
  userId: null;
  version: number;
}

/**
 * RunTokenContext
 *
 * `principal` distinguishes a human-scoped run token from one minted for the
 * deployment service principal. `userId` is null exactly when
 * `principal === 'deployment'`.
 */

export type RunTokenPrincipal = 'user' | 'deployment';

export interface RunTokenContext {
  runId: number;
  userId: string | null;
  principal: RunTokenPrincipal;
  tokenType: 'run';
  version: number;
}

/**
 * AuthTokenPayload
 */

export const authTokenPayloadSchema = z.object({
  iss: z.string().min(1, 'Issuer (iss) is required'),
  sub: z.string().min(1, 'Subject (sub) is required'), // User ID
  exp: z.number().int().positive('Expiration (exp) must be a positive integer'),
  iat: z.number().int().positive('Issued at (iat) must be a positive integer'),
  nbf: z.number().int().positive('Not before (nbf) must be a positive integer'),
  v: z.literal(1, { errorMap: () => ({ message: 'Version must be 1' }) }),
  r: z.object({
    u: z.string().min(1, 'User ID is required'),
    t: z.literal('auth', {
      errorMap: () => ({ message: 'Token type must be "auth"' }),
    }),
  }),
});

export type AuthTokenPayload = z.infer<typeof authTokenPayloadSchema>;

/**
 * AuthTokenContext
 */

export interface UserAuthTokenContext {
  userId: string;
  tokenType: 'auth';
  version: number;
}

export type AuthTokenContext = UserAuthTokenContext;

export const isUserToken = (
  token: { tokenType: string } | undefined,
): token is UserAuthTokenContext => token?.tokenType === 'auth';

/**
 * Browser-issued OAuth token for the public Roomote MCP resource.
 *
 * This is deliberately distinct from the internal user auth token so an MCP
 * client cannot use its bearer credential against the rest of the API.
 */
export const mcpAccessTokenPayloadSchema = z.object({
  iss: z.string().min(1, 'Issuer (iss) is required'),
  sub: z.string().min(1, 'Subject (sub) is required'),
  aud: z.string().url('Audience (aud) must be a URL'),
  exp: z.number().int().positive('Expiration (exp) must be a positive integer'),
  iat: z.number().int().positive('Issued at (iat) must be a positive integer'),
  nbf: z.number().int().positive('Not before (nbf) must be a positive integer'),
  v: z.literal(1, { errorMap: () => ({ message: 'Version must be 1' }) }),
  r: z.object({
    u: z.string().min(1, 'User ID is required'),
    t: z.literal('mcp', {
      errorMap: () => ({ message: 'Token type must be "mcp"' }),
    }),
    s: z.array(z.string().min(1)).min(1, 'At least one scope is required'),
  }),
});

export type McpAccessTokenPayload = z.infer<typeof mcpAccessTokenPayloadSchema>;

export interface McpAccessTokenContext {
  userId: string;
  tokenType: 'mcp';
  version: number;
  resource: string;
  scopes: string[];
}

/**
 * PreviewTokenPayload
 *
 * Preview tokens are user-scoped and work across all previews for that user.
 * The subject is a static 'preview' value (tokens are no longer task-specific).
 */

export const previewTokenPayloadSchema = z.object({
  iss: z.string().min(1, 'Issuer (iss) is required'),
  sub: z.literal('preview', {
    errorMap: () => ({ message: 'Subject must be "preview"' }),
  }),
  exp: z.number().int().positive('Expiration (exp) must be a positive integer'),
  iat: z.number().int().positive('Issued at (iat) must be a positive integer'),
  nbf: z.number().int().positive('Not before (nbf) must be a positive integer'),
  v: z.literal(1, { errorMap: () => ({ message: 'Version must be 1' }) }),
  r: z.object({
    u: z.string().min(1, 'User ID is required'),
    t: z.literal('pt', {
      errorMap: () => ({ message: 'Token type must be "pt"' }),
    }),
  }),
});

export type PreviewTokenPayload = z.infer<typeof previewTokenPayloadSchema>;

/**
 * PreviewTokenContext
 *
 * Preview tokens are user-scoped.
 */

export interface PreviewTokenContext {
  userId: string;
  tokenType: 'pt';
  version: number;
}

/**
 * SandboxOidcTokenPayload
 *
 * Environment-scoped OIDC identity used for sandbox-issued web identity flows
 * such as AWS STS AssumeRoleWithWebIdentity and custom audience-bound
 * integrations.
 */

export const sandboxOidcTokenPayloadSchema = z.object({
  iss: z.string().min(1, 'Issuer (iss) is required'),
  sub: z.string().min(1, 'Subject (sub) is required'),
  aud: z.string().min(1, 'Audience (aud) is required'),
  exp: z.number().int().positive('Expiration (exp) must be a positive integer'),
  iat: z.number().int().positive('Issued at (iat) must be a positive integer'),
  nbf: z.number().int().positive('Not before (nbf) must be a positive integer'),
  jti: z.string().min(1, 'JWT ID (jti) is required'),
  environment_id: z.string().min(1, 'Environment ID is required'),
});

export type SandboxOidcTokenPayload = z.infer<
  typeof sandboxOidcTokenPayloadSchema
>;
