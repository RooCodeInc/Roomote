import type { Context } from 'hono';

import {
  and,
  db,
  environments,
  eq,
  inArray,
  repositories,
  updateEnvironmentDefinition,
} from '@roomote/db/server';
import { environmentConfigSchema } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';
import {
  DUPLICATE_ENVIRONMENT_NAME_ERROR,
  EVAL_ENVIRONMENT_WRITE_ERROR,
  attachEnvironmentIdToTaskRun,
  getEnvironmentRepositoryConfigError,
  getMissingEnvironmentRepositoryError,
  isEnvironmentNameUniqueViolation,
  resolveEnvironmentWriteUserId,
} from './createEnvironment';

function duplicateEnvironmentNameResponse(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Response {
  return c.json({ error: DUPLICATE_ENVIRONMENT_NAME_ERROR }, 409);
}
/**
 * PATCH /api/mcp/environments/:id
 *
 * Updates an existing deployment environment.
 */
export async function updateEnvironment(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const userId = await resolveEnvironmentWriteUserId(auth);

  if (!userId) {
    return c.json({ error: 'User context required' }, 403);
  }

  const id = c.req.param('id');

  if (!id) {
    return c.json({ error: 'Environment id is required' }, 400);
  }

  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'config is required' }, 400);
  }

  const requestBody = body as { config?: unknown; isEval?: unknown };
  const hasConfig = Object.prototype.hasOwnProperty.call(requestBody, 'config');
  const hasIsEval = Object.prototype.hasOwnProperty.call(requestBody, 'isEval');

  if (hasIsEval) {
    return c.json({ error: EVAL_ENVIRONMENT_WRITE_ERROR }, 403);
  }

  if (!hasConfig) {
    return c.json({ error: 'config is required' }, 400);
  }

  try {
    const parsedConfig = environmentConfigSchema.safeParse(requestBody.config);
    if (!parsedConfig.success) {
      const issues = parsedConfig.error.issues.map((issue) => issue.message);
      return c.json(
        {
          error: `Invalid environment configuration: ${issues.join(', ')}`,
        },
        400,
      );
    }

    const config = parsedConfig.data;

    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, id),
      columns: {
        id: true,
        name: true,
        description: true,
        config: true,
        isEval: true,
      },
    });

    if (!environment) {
      return c.json({ error: 'Environment not found' }, 404);
    }

    if (environment.isEval) {
      return c.json({ error: EVAL_ENVIRONMENT_WRITE_ERROR }, 403);
    }

    if (config.name !== environment.name) {
      const existing = await db.query.environments.findFirst({
        where: eq(environments.name, config.name),
        columns: { id: true },
      });

      if (existing && existing.id !== environment.id) {
        return duplicateEnvironmentNameResponse(c);
      }
    }

    const repositoryNames = [
      ...new Set(config.repositories.map((repo) => repo.repository)),
    ];

    const orgRepos =
      repositoryNames.length > 0
        ? await db.query.repositories.findMany({
            where: and(
              eq(repositories.isActive, true),
              inArray(repositories.fullName, repositoryNames),
            ),
            columns: { id: true, fullName: true, installationId: true },
          })
        : [];

    const repositoryConfigError = getEnvironmentRepositoryConfigError(orgRepos);

    if (repositoryConfigError) {
      return c.json({ error: repositoryConfigError }, 400);
    }

    const repoMap = new Map(orgRepos.map((repo) => [repo.fullName, repo.id]));
    const missingRepositoryError = getMissingEnvironmentRepositoryError(
      repositoryNames,
      orgRepos,
    );

    if (missingRepositoryError) {
      return c.json({ error: missingRepositoryError }, 400);
    }

    const repositoryIds = repositoryNames
      .map((name) => repoMap.get(name))
      .filter((repositoryId): repositoryId is string => Boolean(repositoryId));

    await db.transaction(async (tx) => {
      const now = new Date();

      await updateEnvironmentDefinition(tx, {
        environmentId: id,
        fields: {
          name: config.name,
          description: config.description,
          config,
        },
        updatedAt: now,
        repositoryIds,
        configVersion: {
          config: environment.config,
          name: environment.name,
          description: environment.description ?? null,
          source: 'agent',
          createdByUserId: userId,
        },
      });
    });

    await attachEnvironmentIdToTaskRun(auth, id);

    return c.json({
      success: true,
      environmentId: id,
      name: config.name,
      missingRepositories: [],
    });
  } catch (error) {
    if (isEnvironmentNameUniqueViolation(error)) {
      return duplicateEnvironmentNameResponse(c);
    }

    logHandlerError('updateEnvironment', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to update environment',
      },
      500,
    );
  }
}
