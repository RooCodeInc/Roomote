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
  users,
} from '@roomote/db/server';
import {
  type TaskPayload,
  environmentConfigSchema,
  getAmbiguousEnvironmentRepositoryError,
  getDuplicateEnvironmentRepositoryConfigError,
  getMissingEnvironmentRepositoryError,
  getEnvironmentRepositoryInstallationError,
} from '@roomote/types';
import { captureActivationEnvironmentSaved } from '@roomote/telemetry/server';

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
export const ENVIRONMENT_ADMIN_REQUIRED_ERROR =
  'Admin access is required to create or update environments.';

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
  return (
    getAmbiguousEnvironmentRepositoryError(repositoryRows) ??
    getEnvironmentRepositoryInstallationError(repositoryRows)
  );
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
 * (`createdByUserId`). Task-control handlers that act *as* a user
 * (launchTask, sendMessage, steerMessage) intentionally keep stricter
 * mint-time/user gating. task-stop deliberately allows a missing human
 * claim and mints a deployment-principal run token so chat cancel can
 * stop active sandboxes without a mint-time acting user.
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
    // Environment writes must fail closed when a run token is malformed, its
    // task run no longer exists, or the live-actor lookup otherwise fails.
    if (!(error instanceof McpProxyError)) {
      logHandlerError('resolveEnvironmentWriteUserId', error);
    }

    return null;
  }

  return liveActingUserId ?? auth.userId ?? null;
}

export async function canAdministerEnvironments(
  userId: string,
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { role: true, deletedAt: true },
  });

  return user?.role === 'admin' && user.deletedAt == null;
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
 * Resolve the calling task run's Roomote task id, if the write is driven by a
 * run-token task. Used to atomically register that task as the current
 * verification attempt for the environment it just created or applied a
 * runtime-affecting update to. The environment-setup skill runs verification
 * from this same setup task and records the outcome through
 * `record_verification`; registering the caller's taskId means that recording
 * matches server-side without the agent having to hand-pass any task id.
 */
export async function resolveCallingVerificationTaskId(
  auth: McpAuth,
): Promise<string | undefined> {
  const runId = extractRunId(auth);

  if (!runId) {
    return undefined;
  }

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true },
  });

  return taskRun?.taskId ?? undefined;
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

  if (!userId || !(await canAdministerEnvironments(userId))) {
    return c.json({ error: ENVIRONMENT_ADMIN_REQUIRED_ERROR }, 403);
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
  const duplicateRepositoryError = getDuplicateEnvironmentRepositoryConfigError(
    config.repositories,
  );

  if (duplicateRepositoryError) {
    return c.json(
      {
        error: `Invalid environment configuration: ${duplicateRepositoryError}`,
      },
      400,
    );
  }

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
    const missingRepositoryError = getMissingEnvironmentRepositoryError(
      repositoryNames,
      orgRepos,
    );

    if (missingRepositoryError) {
      return c.json({ error: missingRepositoryError }, 400);
    }

    const verificationTaskId = await resolveCallingVerificationTaskId(auth);

    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(environments)
        .values({
          userId: undefined,
          createdByUserId: userId,
          name: config.name,
          description: config.description,
          config,
          // New environments start configured but not yet verified. A
          // follow-up verification task confirms the runtime works. Registering
          // the calling task here means its record_verification matches
          // server-side without the agent hand-passing a task id.
          isVerified: false,
          verificationTaskId: verificationTaskId ?? null,
          verificationError: null,
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
    void captureActivationEnvironmentSaved('mcp');

    return c.json({
      success: true,
      environmentId: created.id,
      name: config.name,
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
