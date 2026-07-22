import type { Context } from 'hono';

import {
  DeploymentReadOnlyError,
  enqueueTask,
  resolveRequestedWorkKindDecision,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  environmentRepositoryMappings,
  environments,
  eq,
  inArray,
  repositories,
} from '@roomote/db/server';
import {
  ADMIN_REQUIRED_LAUNCH_TYPES,
  ALL_REPOSITORIES,
  buildTaskTypePromptAndWorkspacePayload,
  getEnvironmentRepositoryInstallationError,
  type StandardTask,
  type SuggestedTasksTask,
  TaskPayloadKind,
  resolveEvalHarnessSelection,
  type SourceControlProvider,
  TaskTypePromptAndWorkspacePayloadError,
  type TaskLaunchRequest,
  taskLaunchRequestSchema,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { getMembershipRole } from './membership';
import { logHandlerError } from '../utils';

function normalizeRepositoryFullNames(body: TaskLaunchRequest): string[] {
  return [
    ...new Set(
      [
        ...(body.repositoryFullNames ?? []),
        ...(body.selectedRepositories ?? []),
        body.repo && body.repo !== ALL_REPOSITORIES ? body.repo : null,
      ].filter((value): value is string => Boolean(value)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

async function validateSelectedRepositories(
  repositoryFullNames: string[],
  options: { requireSingleInstallation?: boolean } = {},
): Promise<{ error: string; status: 400 | 404 } | null> {
  if (repositoryFullNames.length === 0) {
    return null;
  }

  const orgRepositories = await db.query.repositories.findMany({
    where: and(
      eq(repositories.isActive, true),
      inArray(repositories.fullName, repositoryFullNames),
    ),
    columns: { fullName: true, installationId: true },
  });

  const foundRepositories = new Set(
    orgRepositories.map((repository) => repository.fullName),
  );
  const missingRepository = repositoryFullNames.find(
    (repositoryFullName) => !foundRepositories.has(repositoryFullName),
  );

  if (missingRepository) {
    return {
      error: `Repository not found in this deployment: ${missingRepository}`,
      status: 404,
    };
  }

  if (options.requireSingleInstallation) {
    const installationError =
      getEnvironmentRepositoryInstallationError(orgRepositories);

    if (installationError) {
      return { error: installationError, status: 400 };
    }
  }

  return null;
}

function resolveSingleSourceControlProvider(
  providers: SourceControlProvider[],
): SourceControlProvider | undefined {
  const uniqueProviders = [...new Set(providers)];

  if (uniqueProviders.length > 1) {
    throw new Error(
      'Selected repositories must belong to a single source control provider.',
    );
  }

  return uniqueProviders[0];
}

async function resolveLaunchSourceControlProvider({
  repositoryFullNames,
  environmentId,
}: {
  repositoryFullNames: string[];
  environmentId: string | undefined;
}): Promise<SourceControlProvider | undefined> {
  if (repositoryFullNames.length > 0) {
    const rows = await db
      .select({ sourceControlProvider: repositories.sourceControlProvider })
      .from(repositories)
      .where(
        and(
          eq(repositories.isActive, true),
          inArray(repositories.fullName, repositoryFullNames),
        ),
      );
    const provider = resolveSingleSourceControlProvider(
      rows.map((row) => row.sourceControlProvider),
    );

    if (provider) {
      return provider;
    }
  }

  if (environmentId) {
    const rows = await db
      .select({ sourceControlProvider: repositories.sourceControlProvider })
      .from(environmentRepositoryMappings)
      .innerJoin(
        repositories,
        eq(environmentRepositoryMappings.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(environmentRepositoryMappings.environmentId, environmentId),
          eq(repositories.isActive, true),
        ),
      );

    return resolveSingleSourceControlProvider(
      rows.map((row) => row.sourceControlProvider),
    );
  }

  return undefined;
}

/**
 * POST /api/tasks
 *
 * Launch a new Roomote task.
 */
export async function launchTask(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');

  if (!auth.userId) {
    return c.json({ error: 'User context required' }, 403);
  }

  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsedBody = taskLaunchRequestSchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return c.json(
      { error: parsedBody.error.issues[0]?.message ?? 'Invalid request body' },
      400,
    );
  }

  const body = parsedBody.data;
  const requestedType = body.type ?? 'standard';

  // Resolve harness/model/reasoning into a harness pin plus model override,
  // sharing the same validation the Slack `!eval` launcher uses. This is what
  // lets `model` actually reach the harness from the API (a bare `harness`
  // selects the default model otherwise).
  const harnessSelection = resolveEvalHarnessSelection({
    harness: body.harness,
    model: body.model,
    reasoningEffort: body.reasoningEffort,
  });

  if (!harnessSelection.ok) {
    return c.json({ error: harnessSelection.error }, 400);
  }
  const repositoryFullNames = normalizeRepositoryFullNames(body);
  const shouldValidateRepositorySelection =
    requestedType !== 'standard' ||
    Boolean(
      body.repositoryFullNames?.length || body.selectedRepositories?.length,
    );
  const taskType =
    requestedType === 'suggested-tasks'
      ? TaskPayloadKind.Scan
      : TaskPayloadKind.StandardTask;
  const requiresAdmin = ADMIN_REQUIRED_LAUNCH_TYPES.has(requestedType);

  try {
    const membershipRole = await getMembershipRole(auth);

    if (!membershipRole) {
      return c.json({ error: 'Unauthorized' }, 403);
    }

    if (requiresAdmin && membershipRole !== 'org:admin') {
      return c.json({ error: 'Unauthorized' }, 403);
    }

    const repositoryValidationError = shouldValidateRepositorySelection
      ? await validateSelectedRepositories(repositoryFullNames, {
          requireSingleInstallation: requestedType === 'environment-definition',
        })
      : null;

    if (repositoryValidationError) {
      return c.json(
        { error: repositoryValidationError.error },
        repositoryValidationError.status,
      );
    }

    if (body.environmentId) {
      const environment = await db.query.environments.findFirst({
        where: eq(environments.id, body.environmentId),
        columns: { id: true },
      });

      if (!environment) {
        return c.json({ error: 'Environment not found' }, 404);
      }
    }

    const taskTypePayload = buildTaskTypePromptAndWorkspacePayload({
      type: requestedType,
      prompt: body.prompt,
      repo: body.repo,
      repositoryFullNames,
      setupGuidance: body.setupGuidance,
    });

    if (!taskTypePayload.taskPrompt && !body.prompt) {
      return c.json({ error: 'prompt is required' }, 400);
    }

    const visibleInTranscript =
      typeof body.visibleInTranscript === 'boolean'
        ? body.visibleInTranscript
        : body.hidden === true
          ? false
          : taskTypePayload.visibleInTranscript;

    const workspacePayload = body.environmentId
      ? {
          repo:
            body.repo ??
            repositoryFullNames[0] ??
            taskTypePayload.workspacePayload.repo,
          environmentId: body.environmentId,
        }
      : taskTypePayload.workspacePayload;

    let sourceControlProvider: SourceControlProvider | undefined;

    try {
      sourceControlProvider = await resolveLaunchSourceControlProvider({
        repositoryFullNames,
        environmentId: body.environmentId,
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to resolve source control provider',
        },
        400,
      );
    }

    const basePayload = {
      ...workspacePayload,
      ...(sourceControlProvider ? { sourceControlProvider } : {}),
      branch: body.branch,
      sha: body.sha,
      description: taskTypePayload.taskPrompt,
      visibleInTranscript,
      reasoningEffort: body.reasoningEffort,
      ...(harnessSelection.harnessModelOverrides
        ? { harnessModelOverrides: harnessSelection.harnessModelOverrides }
        : {}),
    };

    const requestedWorkKindDecision = await resolveRequestedWorkKindDecision({
      prompt: taskTypePayload.taskPrompt,
      bootstrapSkill:
        requestedType === 'standard' ? body.bootstrap?.skill : undefined,
      userId: auth.userId,
    });

    // A settle notification needs a durable pointer back to the launching
    // run, so the opt-in only takes effect on run-token launches.
    const notifySourceRunOnSettle =
      requestedType === 'standard' &&
      body.notifyOnSettle === true &&
      'runId' in auth.authContext;

    const taskBase = {
      harness: harnessSelection.harness ?? body.harness,
      computeProvider: body.computeProvider,
      requestedWorkKindDecision,
      ...((requestedType === 'environment-definition' ||
        notifySourceRunOnSettle) &&
      'runId' in auth.authContext
        ? { sourceRunId: auth.authContext.runId }
        : {}),
    };

    const task: StandardTask | SuggestedTasksTask =
      taskType === TaskPayloadKind.Scan
        ? {
            ...taskBase,
            type: TaskPayloadKind.Scan,
            payload: {
              ...basePayload,
              trigger: body.trigger ?? 'scheduled',
              notifySlack: body.notifySlack ?? false,
            },
          }
        : {
            ...taskBase,
            type: TaskPayloadKind.StandardTask,
            payload: {
              ...basePayload,
              bootstrap:
                requestedType === 'standard' ? body.bootstrap : undefined,
              ...(notifySourceRunOnSettle
                ? { notifySourceRunOnSettle: true }
                : {}),
            },
          };

    // A human explicitly asked for this launch via the API, so the human is
    // the initiator even for the hidden scan branch (the old automation stamp
    // made the requesting human invisible).
    const launchResult = await enqueueTask(
      {
        task,
        initiator: { kind: 'user', userId: auth.userId },
        workflow: task.type === TaskPayloadKind.Scan ? 'scan' : 'standard',
        surface: 'api',
        trigger: 'manual',
        ...(task.type === TaskPayloadKind.Scan
          ? { visibility: 'hidden' as const }
          : {}),
      },
      {
        launchClass:
          task.type === TaskPayloadKind.Scan ? 'automation' : 'human',
      },
    );

    return c.json({
      success: true,
      runId: launchResult.id,
      taskId: launchResult.taskId,
    });
  } catch (error) {
    if (error instanceof TaskTypePromptAndWorkspacePayloadError) {
      return c.json({ error: error.message }, 400);
    }

    if (error instanceof DeploymentReadOnlyError) {
      return c.json({ error: error.code }, 409);
    }

    logHandlerError('launchTask', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to launch task',
      },
      500,
    );
  }
}
