import type { Context } from 'hono';

import { db, environments, eq } from '@roomote/db/server';

import type { Variables } from '../../types';

import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';

/**
 * GET /api/environments
 *
 * List all deployment environments.
 */
export async function listEnvironments(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  try {
    // Fetch environments with their repository mappings.
    const envs = await db.query.environments.findMany({
      where: eq(environments.isEval, false),
      columns: { id: true, name: true, description: true },
      with: {
        repositoryMappings: {
          with: { repository: { columns: { id: true, fullName: true } } },
        },
      },
    });

    const environmentList = envs.map((env) => ({
      id: env.id,
      name: env.name,
      description: env.description,
      repositories: env.repositoryMappings.map((rm) => ({
        id: rm.repository.id,
        fullName: rm.repository.fullName,
      })),
    }));

    return c.json({ environments: environmentList });
  } catch (error) {
    logHandlerError('listEnvironments', error);
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to list environments',
      },
      500,
    );
  }
}
