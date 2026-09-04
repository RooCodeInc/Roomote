import { randomUUID } from 'node:crypto';

import type { Context } from 'hono';

import {
  DeploymentReadOnlyError,
  enqueueTask,
  launchPinnedFastSessionTask,
  refreshFastAgentSessionTitle,
  resolveRequestedWorkKindDecision,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  environments,
  eq,
  inArray,
  repositories,
  resolveWorkspaceRepositoryProviders,
  taskRuns,
} from '@roomote/db/server';
import {
  ADMIN_REQUIRED_LAUNCH_TYPES,
  ALL_REPOSITORIES,
  buildTaskTypePromptAndWorkspacePayload,
  type ComputeProvider,
  getEnvironmentRepositoryInstallationError,
  getFastAgentParentFromPayload,
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
import { resolveMcpTaskOrSessionUserId, type McpAuth } from '../mcp/middleware';
import { handlePrReviewLaunch } from './launchPrReview';
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
  ];
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

async function resolveLaunchSourceControlProvider({
  repositoryFullNames,
  environmentId,
}: {
  repositoryFullNames: string[];
  environmentId: string | undefined;
}): Promise<SourceControlProvider | undefined> {
  if (repositoryFullNames.length > 0) {
    const repositoryProviders = await resolveWorkspaceRepositoryProviders(db, {
      type: 'repository_set',
      repositories: repositoryFullNames,
    });
    const unresolvedRepositories = repositoryFullNames.filter(
      (repositoryFullName) =>
        repositoryProviders[repositoryFullName] === undefined,
    );

    if (unresolvedRepositories.length > 0) {
      throw new Error(
        `Could not unambiguously resolve source control for: ${unresolvedRepositories.join(', ')}`,
      );
    }

    return Object.values(repositoryProviders)[0];
  }

  if (environmentId) {
    const repositoryProviders = await resolveWorkspaceRepositoryProviders(db, {
      type: 'environment',
      environmentId,
    });
    return Object.values(repositoryProviders)[0];
  }

  return undefined;
}

/**
 * A run launched from inside a Fast-delegated task keeps its children in the
 * same Session, so the whole tree stays visible in one place.
 */
async function resolveLaunchParentFastConversationId(
  auth: McpAuth,
): Promise<string | null> {
  if (!('runId' in auth.authContext)) {
    return null;
  }

  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, auth.authContext.runId),
    columns: { payload: true },
  });

  return getFastAgentParentFromPayload(sourceRun?.payload)?.sessionId ?? null;
}

async function resolveLaunchComputeProvider({
  requestedProvider,
  auth,
}: {
  requestedProvider: ComputeProvider | undefined;
  auth: McpAuth;
}): Promise<ComputeProvider | undefined> {
  if (requestedProvider || !('runId' in auth.authContext)) {
    return requestedProvider;
  }

  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, auth.authContext.runId),
    columns: { vendor: true },
  });

  return sourceRun?.vendor ?? undefined;
}

/**
 * POST /api/tasks
 *
 * Launch a new Roomote task.
 */
export async function launchTask(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const requestAuth = c.get('mcpAuth');
  const auth = {
    ...requestAuth,
    userId: await resolveMcpTaskOrSessionUserId(requestAuth),
  };

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

  // Resolve harness/model/reasoning into a harness pin plus model override so
  // `model` reaches the harness (a bare `harness` selects its default model).
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

    // The review pipeline has its own target resolution (a PR, not a prompt
    // and workspace), so it branches before the standard launch machinery.
    if (requestedType === 'pr-review') {
      return await handlePrReviewLaunch(c, { userId: auth.userId }, body);
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

    let environmentName: string | undefined;

    if (body.environmentId) {
      const environment = await db.query.environments.findFirst({
        where: eq(environments.id, body.environmentId),
        columns: { id: true, name: true },
      });

      if (!environment) {
        return c.json({ error: 'Environment not found' }, 404);
      }

      environmentName = environment.name;
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
    const computeProvider = await resolveLaunchComputeProvider({
      requestedProvider: body.computeProvider,
      auth,
    });

    // A settle notification needs a durable pointer back to the launching
    // run, so the opt-in only takes effect on run-token launches.
    const notifySourceRunOnSettle =
      requestedType === 'standard' &&
      body.notifyOnSettle === true &&
      'runId' in auth.authContext;

    const taskBase = {
      harness: harnessSelection.harness ?? body.harness,
      computeProvider,
      requestedWorkKindDecision,
      ...((requestedType === 'environment-definition' ||
        notifySourceRunOnSettle) &&
      'runId' in auth.authContext
        ? { sourceRunId: auth.authContext.runId }
        : {}),
      // Run-token launches carry the parent pointer for read-only
      // source-context inheritance, without widening sourceRunId semantics.
      ...('runId' in auth.authContext &&
      (requestedType === 'standard' ||
        requestedType === 'environment-definition')
        ? { communicationContextSourceRunId: auth.authContext.runId }
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
    if (task.type === TaskPayloadKind.StandardTask) {
      // A standard launch always belongs to a Session: the caller's own Fast
      // Session when a delegated task is launching a sibling, otherwise a new
      // Session owned by the requesting person.
      const launch = await launchPinnedFastSessionTask({
        userId: auth.userId,
        fastConversationId: await resolveLaunchParentFastConversationId(auth),
        launchId: body.launchId ?? randomUUID(),
        prompt: taskTypePayload.taskPrompt,
        task,
        surface: 'api',
        trigger: 'manual',
        initiator: { kind: 'user', userId: auth.userId },
        kickoffMessage: environmentName
          ? `Started a task in ${environmentName}.`
          : 'Started a task.',
      });

      // No Fast turn runs for a pinned launch, so title the Session from the
      // recorded request without holding the response.
      void refreshFastAgentSessionTitle({
        sessionId: launch.fastConversationId,
        userId: auth.userId,
      }).catch((error: unknown) => {
        logHandlerError('launchTask:refreshSessionTitle', error);
      });

      return c.json({
        success: true,
        runId: launch.runId,
        taskId: launch.taskId,
        sessionId: launch.sessionId,
      });
    }

    const launchResult = await enqueueTask(
      {
        task,
        initiator: { kind: 'user', userId: auth.userId },
        workflow: 'scan',
        surface: 'api',
        trigger: 'manual',
        visibility: 'hidden',
      },
      { launchClass: 'automation' },
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
