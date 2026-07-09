import { z } from 'zod';

/**
 * JobTokenPayload
 */

export const jobTokenPayloadSchema = z.object({
  iss: z.string().min(1, 'Issuer (iss) is required'),
  sub: z.string().min(1, 'Subject (sub) is required'), // CloudJob ID
  exp: z.number().int().positive('Expiration (exp) must be a positive integer'),
  iat: z.number().int().positive('Issued at (iat) must be a positive integer'),
  nbf: z.number().int().positive('Not before (nbf) must be a positive integer'),
  v: z.literal(1, { errorMap: () => ({ message: 'Version must be 1' }) }),
  r: z.object({
    // Absent user claim means the job runs as the deployment service
    // principal (automation-initiated work with no human driver).
    u: z.string().min(1, 'User ID must be non-empty when present').optional(),
    t: z.literal('cj', {
      errorMap: () => ({ message: 'Token type must be "cj"' }),
    }),
  }),
});

export type JobTokenPayload = z.infer<typeof jobTokenPayloadSchema>;

/**
 * JobTokenContext
 *
 * `principal` distinguishes a human-scoped job token from one minted for the
 * deployment service principal. `userId` is null exactly when
 * `principal === 'deployment'`.
 */

export type JobTokenPrincipal = 'user' | 'deployment';

export interface JobTokenContext {
  cloudJobId: number;
  userId: string | null;
  principal: JobTokenPrincipal;
  tokenType: 'cj';
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
  token: AuthTokenContext | undefined,
): token is UserAuthTokenContext =>
  typeof token === 'object' && 'userId' in token;

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
