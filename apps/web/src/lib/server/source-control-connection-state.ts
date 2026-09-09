import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getBetterAuthSecret } from './env';

const payloadSchema = z.object({
  actorUserId: z.string().min(1),
  provider: z.enum(['github', 'gitlab', 'gitea', 'bitbucket', 'ado']),
  purpose: z.enum(['github-install', 'github-manifest']).optional(),
  returnTarget: z.string(),
  requestId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().optional(),
  issuedAt: z.number(),
  nonce: z.string().uuid(),
});
export type SourceControlConnectionState = z.infer<typeof payloadSchema>;
export const isConnectionState = (
  state: string | null | undefined,
): state is string => Boolean(state?.startsWith('sc.'));

export function signConnectionState(
  input: Omit<SourceControlConnectionState, 'issuedAt' | 'nonce'>,
) {
  const payload = Buffer.from(
    JSON.stringify({ ...input, issuedAt: Date.now(), nonce: randomUUID() }),
  ).toString('base64url');
  const signature = createHmac('sha256', getBetterAuthSecret())
    .update(`source-control:${payload}`)
    .digest('base64url');
  return `sc.${payload}.${signature}`;
}

export function verifyConnectionState(
  state: string,
  actorUserId: string,
  provider: SourceControlConnectionState['provider'],
) {
  const [prefix, payload, signature, ...rest] = state.split('.');
  if (prefix !== 'sc' || !payload || !signature || rest.length)
    throw new Error('Invalid connection attempt.');
  const expected = createHmac('sha256', getBetterAuthSecret())
    .update(`source-control:${payload}`)
    .digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Invalid connection attempt.');
  const value = payloadSchema.parse(
    JSON.parse(Buffer.from(payload, 'base64url').toString()),
  );
  const maxAge = provider === 'github' ? 3600000 : 600000;
  if (
    value.actorUserId !== actorUserId ||
    value.provider !== provider ||
    value.issuedAt > Date.now() ||
    Date.now() - value.issuedAt > maxAge ||
    Boolean(value.requestId) !== (value.revision !== undefined)
  )
    throw new Error('Invalid or expired connection attempt.');
  return value;
}
