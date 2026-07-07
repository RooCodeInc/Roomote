import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

import { validateJobToken, validateAuthToken } from '@roomote/auth';
import { db, deploymentSettings, eq } from '@roomote/db/server';

import type { Variables } from '../types';

function isRoomoteDeploymentDisabled(metadata: unknown): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'deployment_disabled' in metadata &&
    metadata.deployment_disabled === true
  );
}

async function deploymentAllowsTokenAuth(): Promise<boolean> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
    columns: {
      metadata: true,
    },
  });

  return !isRoomoteDeploymentDisabled(deployment?.metadata);
}

export const tokenAuthMiddleware = () =>
  createMiddleware(async (c: Context<{ Variables: Variables }>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // Try job token first (has more specific claims)
      let isJobToken = false;

      try {
        const jobContext = await validateJobToken(token);
        if (await deploymentAllowsTokenAuth()) {
          c.set('authContext', jobContext);
          isJobToken = true;
        }
      } catch {
        // Not a job token, try auth token below
      }

      if (isJobToken) {
        await next();
        return;
      }

      try {
        const authContext = await validateAuthToken(token);
        if (await deploymentAllowsTokenAuth()) {
          c.set('authContext', authContext);
        }
      } catch (error) {
        console.error(
          `Failed to validate token: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await next();
  });
