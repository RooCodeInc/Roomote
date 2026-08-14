import type { Context } from 'hono';

import { and, db, environments, eq, isNull } from '@roomote/db/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';
import {
  ENVIRONMENT_TASK_CAPABILITY_ERROR,
  canAdministerEnvironments,
  canTaskRunReadEnvironmentConfig,
  resolveEnvironmentAdminUserId,
} from './createEnvironment';

export const ENVIRONMENT_READ_ADMIN_REQUIRED_ERROR =
  'Admin access is required to view environment configuration.';

/**
 * GET /api/environments/:id
 *
 * Return a single deployment environment with repository mappings and config.
 */
export async function getEnvironment(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const userId = await resolveEnvironmentAdminUserId(auth);

  if (!userId || !(await canAdministerEnvironments(userId))) {
    return c.json({ error: ENVIRONMENT_READ_ADMIN_REQUIRED_ERROR }, 403);
  }

  if (!(await canTaskRunReadEnvironmentConfig(auth))) {
    return c.json({ error: ENVIRONMENT_TASK_CAPABILITY_ERROR }, 403);
  }

  const environmentId = c.req.param('id');

  if (!environmentId?.trim()) {
    return c.json({ error: 'Environment id is required' }, 400);
  }

  try {
    const environment = await db.query.environments.findFirst({
      where: and(
        eq(environments.id, environmentId),
        isNull(environments.userId),
        eq(environments.isEval, false),
      ),
      columns: {
        id: true,
        name: true,
        description: true,
        config: true,
      },
      with: {
        repositoryMappings: {
          with: { repository: { columns: { id: true, fullName: true } } },
        },
      },
    });

    if (!environment) {
      return c.json({ error: 'Environment not found' }, 404);
    }

    return c.json({
      id: environment.id,
      name: environment.name,
      description: environment.description,
      config: environment.config,
      repositories: environment.repositoryMappings.map((mapping) => ({
        id: mapping.repository.id,
        fullName: mapping.repository.fullName,
      })),
    });
  } catch (error) {
    logHandlerError('getEnvironment', error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to get environment',
      },
      500,
    );
  }
}
