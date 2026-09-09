import { z } from 'zod';

// Deliberately concrete schemas: these also become provider tool schemas.
export const sessionSecretPrepareSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    origin: z.string().min(1).max(2048),
    headerName: z.enum(['authorization', 'x-api-key', 'api-key']),
    headerPrefix: z.enum(['', 'Bearer ', 'Basic ', 'Token ']),
    ttlHours: z.number().int().min(1).max(720).default(24),
  })
  .strict();

export const sessionSecretCreateSchema = z
  .object({
    pendingRef: z.string().uuid(),
    secret: z.string().min(8).max(4096),
  })
  .strict();

export const sessionSecretRevokeSchema = z
  .object({
    secretRef: z.string().uuid(),
  })
  .strict();

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

export type SessionSecretRequestResult =
  | { success: true; status: number; body: string }
  | { success: false; error: 'Secret request unavailable' };
