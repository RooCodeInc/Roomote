import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

import {
  validateAuthToken,
  validateMcpAccessToken,
  validateRunToken,
} from '@roomote/auth';
import { db, deploymentSettings, eq, users } from '@roomote/db/server';
import { isRoomoteDeploymentDisabled } from '@roomote/types';

import type { Variables } from '../types';

async function deploymentAllowsTokenAuth(): Promise<boolean> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
    columns: {
      metadata: true,
    },
  });

  return !isRoomoteDeploymentDisabled(deployment?.metadata);
}

const INFERENCE_GATEWAY_PATH_PREFIX = '/api/inference';

/**
 * Provider SDKs pointed at the inference gateway send their "API key" (the
 * run token) through provider-specific headers: `x-api-key` for Anthropic,
 * `x-goog-api-key` for Gemini. Accept the token from those headers on the
 * inference gateway surface only; everywhere else the Authorization bearer
 * header remains the single token transport.
 */
function extractBearerToken(
  c: Context<{ Variables: Variables }>,
): string | undefined {
  const authHeader = c.req.header('Authorization');

  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  const path = c.req.path;

  if (
    path === INFERENCE_GATEWAY_PATH_PREFIX ||
    path.startsWith(`${INFERENCE_GATEWAY_PATH_PREFIX}/`)
  ) {
    return c.req.header('x-api-key') ?? c.req.header('x-goog-api-key');
  }

  return undefined;
}

export const tokenAuthMiddleware = () =>
  createMiddleware(async (c: Context<{ Variables: Variables }>, next: Next) => {
    const token = extractBearerToken(c);

    if (token) {
      // Try run token first (has more specific claims)
      let isRunToken = false;

      try {
        const jobContext = await validateRunToken(token);
        if (await deploymentAllowsTokenAuth()) {
          c.set('authContext', jobContext);
          isRunToken = true;
        }
      } catch {
        // Not a run token, try auth token below
      }

      if (isRunToken) {
        await next();
        return;
      }

      let userScopedAuth:
        | Awaited<ReturnType<typeof validateMcpAccessToken>>
        | Awaited<ReturnType<typeof validateAuthToken>>
        | undefined;

      try {
        userScopedAuth = await validateMcpAccessToken(token);
      } catch {
        // Not an MCP OAuth token, try the internal user auth token below.
      }

      try {
        userScopedAuth ??= await validateAuthToken(token);
      } catch (error) {
        if (!userScopedAuth) {
          console.error(
            `Failed to validate token: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (userScopedAuth && (await deploymentAllowsTokenAuth())) {
        try {
          const user = await db.query.users.findFirst({
            where: eq(users.id, userScopedAuth.userId),
            columns: { id: true, deletedAt: true },
          });

          // Removed users keep no standing access: their API tokens die with them.
          if (user && user.deletedAt == null) {
            c.set('authContext', userScopedAuth);
          }
        } catch (error) {
          console.error(
            `Failed to resolve token user: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    await next();
  });
