import type { Context } from 'hono';

import {
  and,
  createEnvironmentConfigVersionSnapshot,
  db,
  environmentRepositoryMappings,
  environments,
  eq,
  inArray,
  repositories,
  taskRuns,
} from '@roomote/db/server';
import {
  type TaskPayload,
  environmentConfigSchema,
  getEnvironmentRepositoryInstallationError,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { McpProxyError, resolveActingUserIdOrNull } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

const UNIQUE_VIOLATION_CODE = '23505';
const ENVIRONMENT_NAME_UNIQUE_CONSTRAINT = 'environments_name_unique';
export const DUPLICATE_ENVIRONMENT_NAME_ERROR =
  'An environment with this name already exists. This endpoint only creates new environments.';
export const EVAL_ENVIRONMENT_WRITE_ERROR =
  'isEval is reserved for internal eval environments.';

type PostgresErrorLike = {
  code?: string;
  constraint?: string;
  message?: string;
};

function duplicateEnvironmentNameResponse(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Response {
  return c.json({ error: DUPLICATE_ENVIRONMENT_NAME_ERROR }, 409);
}

export function isEnvironmentNameUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const dbError = error as PostgresErrorLike;
  if (dbError.code !== UNIQUE_VIOLATION_CODE) {
    return false;
  }

  if (dbError.constraint === ENVIRONMENT_NAME_UNIQUE_CONSTRAINT) {
    return true;
  }

  return (
    typeof dbError.message === 'string' &&
    dbError.message.includes(ENVIRONMENT_NAME_UNIQUE_CONSTRAINT)
  );
}

export function getEnvironmentRepositoryConfigError(
  repositoryRows: Array<{
    fullName: string;
    installationId: string | number | null | undefined;
  }>,
): string | null {
  return getEnvironmentRepositoryInstallationError(repositoryRows);
}

function extractRunId(auth: McpAuth): number | null {
  return 'runId' in auth.authContext ? auth.authContext.runId : null;
}

/**
 * Resolve the human user an environment write should be attributed to.
 *
 * Chat-started task runs (for example Slack app mentions) are dequeued before
 * an acting user is attached, so their run tokens are minted as the
 * deployment service principal with no mint-time user claim even when a
 * linked human is driving the task. The live actor lives on
 * `task_runs.actingUserId` — written only by trusted server-side writers
 * (web steer, follow-up delivery) — so prefer it the same way the MCP proxy
 * does and fall back to the token's mint-time claim. Returns null when no
 * human actor can be resolved; environment writes stay forbidden for pure
 * deployment-principal automation.
 *
 * This live-actor resolution is deliberately scoped to environment writes,
 * where the resolved user only feeds deployment-scoped attribution
 * (`createdByUserId`). The task-control handlers (launchTask, sendMessage,
 * steerMessage, task-stop) act *as* a user and intentionally keep their
 * stricter mint-time/user gating.
 */
export async function resolveEnvironmentWriteUserId(
  auth: McpAuth,
): Promise<string | null> {
  let liveActingUserId: string | null = null;

  try {
    liveActingUserId = await resolveActingUserIdOrNull({
      userId: auth.userId ?? null,
      tokenType: auth.authContext.tokenType,
      runId: extractRunId(auth) ?? undefined,
    });
  } catch (error) {
    // A malformed run token or a missing task run means there is no
    // resolvable live actor; fall back to mint-time attribution. Unexpected
    // lookup failures degrade the same way (matching pre-live-actor
    // behavior) instead of escaping the handler's structured error path.
    if (!(error instanceof McpProxyError)) {
      logHandlerError('resolveEnvironmentWriteUserId', error);
    }
  }

  return liveActingUserId ?? auth.userId ?? null;
}

/**
 * When environment creation/update is triggered by a running task run, persist
 * the resulting environment id on that job payload so the UI can resolve
 * completion against the exact task instance instead of timestamp heuristics.
 */
export async function attachEnvironmentIdToTaskRun(
  auth: McpAuth,
  environmentId: string,
): Promise<void> {
  const runId = extractRunId(auth);

  if (!runId) {
    return;
  }

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: {
      id: true,
      payload: true,
    },
  });

  if (!taskRun) {
    return;
  }

  const payload =
    taskRun.payload &&
    typeof taskRun.payload === 'object' &&
    !Array.isArray(taskRun.payload)
      ? (taskRun.payload as Record<string, unknown>)
      : {};

  const existingEnvironmentDefinitionId =
    payload.environmentDefinitionId ?? payload.projectDefinitionEnvironmentId;

  if (existingEnvironmentDefinitionId === environmentId) {
    return;
  }

  await db
    .update(taskRuns)
    .set({
      payload: {
        ...payload,
        environmentDefinitionId: environmentId,
      } as unknown as TaskPayload,
    })
    .where(eq(taskRuns.id, taskRun.id));
}

/**
 * POST /api/mcp/environments
 *
 * Creates a new environment for the deployment.
 * This endpoint is create-only; duplicate names return 409.
 */
export async function createEnvironment(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');
  const userId = await resolveEnvironmentWriteUserId(auth);

  if (!userId) {
    return c.json({ error: 'User context required' }, 403);
  }

  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || typeof body !== 'object' || !('config' in body)) {
    return c.json({ error: 'config is required' }, 400);
  }

  const requestBody = body as { config: unknown; isEval?: unknown };

  if (
    Object.prototype.hasOwnProperty.call(requestBody, 'isEval') &&
    typeof requestBody.isEval !== 'boolean'
  ) {
    return c.json({ error: 'isEval must be a boolean' }, 400);
  }

  if (Object.prototype.hasOwnProperty.call(requestBody, 'isEval')) {
    return c.json({ error: EVAL_ENVIRONMENT_WRITE_ERROR }, 403);
  }

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
  try {
    const existing = await db.query.environments.findFirst({
      where: eq(environments.name, config.name),
      columns: { id: true },
    });

    if (existing) {
      return duplicateEnvironmentNameResponse(c);
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
    const missingRepositories = repositoryNames.filter(
      (name) => !repoMap.has(name),
    );

    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(environments)
        .values({
          userId: undefined,
          createdByUserId: userId,
          name: config.name,
          description: config.description,
          config,
        })
        .returning({ id: environments.id });

      const environment = inserted[0];
      if (!environment) {
        throw new Error('Failed to create environment');
      }

      await createEnvironmentConfigVersionSnapshot(tx, {
        environmentId: environment.id,
        config,
        name: config.name,
        description: config.description ?? null,
        source: 'setup',
        createdByUserId: userId,
      });

      const mappings = repositoryNames
        .map((name) => repoMap.get(name))
        .filter((repositoryId): repositoryId is string => Boolean(repositoryId))
        .map((repositoryId) => ({
          environmentId: environment.id,
          repositoryId,
        }));

      if (mappings.length > 0) {
        await tx.insert(environmentRepositoryMappings).values(mappings);
      }

      return environment;
    });

    await attachEnvironmentIdToTaskRun(auth, created.id);

    return c.json({
      success: true,
      environmentId: created.id,
      name: config.name,
      missingRepositories,
    });
  } catch (error) {
    if (isEnvironmentNameUniqueViolation(error)) {
      return duplicateEnvironmentNameResponse(c);
    }

    logHandlerError('createEnvironment', error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to create environment',
      },
      500,
    );
  }
}
