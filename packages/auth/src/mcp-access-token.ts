import jwt from 'jsonwebtoken';
import { z } from 'zod';

import {
  type McpAccessTokenContext,
  type McpAccessTokenPayload,
  mcpAccessTokenPayloadSchema,
} from '@roomote/types';

import {
  getJobAuthPrivateKey,
  getJobAuthPublicKey,
  isAuthClientTestEnv,
} from './client-runtime';
import {
  decodeEs256PrivateKeyPem,
  decodeEs256PublicKeyPem,
} from './decode-es256-key';

const ISSUER = 'rcc';
export const ROOMOTE_MCP_SCOPE = 'mcp:roomote';
export const ROOMOTE_MCP_PATH = '/mcp';
export const ROOMOTE_MCP_LEGACY_PATH = '/api/mcp-routing/roomote';
export const DEFAULT_MCP_ACCESS_TOKEN_TIMEOUT_MS = 60 * 60 * 1000;

export function getRoomoteMcpResourceUrl(apiBaseUrl: string): string {
  return new URL(ROOMOTE_MCP_PATH, apiBaseUrl).toString();
}

export function getLegacyRoomoteMcpResourceUrl(apiBaseUrl: string): string {
  return new URL(ROOMOTE_MCP_LEGACY_PATH, apiBaseUrl).toString();
}

const createMcpAccessTokenOptionsSchema = z.object({
  userId: z.string().min(1),
  resource: z.string().url(),
  scopes: z.array(z.literal(ROOMOTE_MCP_SCOPE)).min(1),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_MCP_ACCESS_TOKEN_TIMEOUT_MS),
});

export type CreateMcpAccessTokenOptions = z.infer<
  typeof createMcpAccessTokenOptionsSchema
>;

export async function createMcpAccessToken(
  options: CreateMcpAccessTokenOptions,
): Promise<string> {
  const { userId, resource, scopes, timeoutMs } =
    createMcpAccessTokenOptionsSchema.parse(options);
  const now = Math.floor(Date.now() / 1000);

  const payload: McpAccessTokenPayload = {
    iss: ISSUER,
    sub: userId,
    aud: resource,
    exp: now + Math.floor(timeoutMs / 1000),
    iat: now,
    nbf: now - 30,
    v: 1,
    r: {
      u: userId,
      t: 'mcp',
      s: scopes,
    },
  };

  const privateKey = decodeEs256PrivateKeyPem(
    getJobAuthPrivateKey(),
    'JOB_AUTH_PRIVATE_KEY',
  );

  return jwt.sign(payload, privateKey, { algorithm: 'ES256' });
}

export async function validateMcpAccessToken(
  token: string,
): Promise<McpAccessTokenContext> {
  const publicKey = decodeEs256PublicKeyPem(
    getJobAuthPublicKey(),
    'JOB_AUTH_PUBLIC_KEY',
  );
  const rawPayload = jwt.verify(token, publicKey, {
    algorithms: ['ES256'],
    clockTolerance: 60,
    ignoreNotBefore: isAuthClientTestEnv(),
    issuer: ISSUER,
  });
  const payload = mcpAccessTokenPayloadSchema.parse(rawPayload);

  return {
    userId: payload.r.u,
    tokenType: 'mcp',
    version: payload.v,
    resource: payload.aud,
    scopes: payload.r.s,
  };
}
