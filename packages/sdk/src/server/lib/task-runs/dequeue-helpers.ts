import {
  CONTROL_PLANE_ENV_VAR_NAMES,
  RunStatus,
  buildSourceControlTokenMetadata,
  getSourceControlProviderLabel,
  resolveTaskWorkspace,
  resolveSourceControlProviderFromPayload,
  type SourceControlProvider,
  type SourceControlTokenMetadata,
} from '@roomote/types';
import {
  type TaskRun,
  db,
  taskRuns,
  tasks,
  markTaskStartParallelCountEndedAt,
  resolveEffectiveModelRuntimeEnv,
  resolveWorkspaceSourceControlProvider,
  stringifyDecryptedEnvVarValue,
  syncTaskStateFromRuns,
  eq,
  sql,
} from '@roomote/db/server';
import { decryptSecrets } from '@roomote/db/encryption';
import { createTaskRunWorkerGitHubToken } from '@roomote/github';
import { createTaskRunScopedGitLabTokens } from '@roomote/gitlab';
import { createTaskRunBitbucketCredentials } from '@roomote/bitbucket';
import { createTaskRunGiteaCredentials } from '@roomote/gitea';
import { createTaskRunAdoCredentials } from '@roomote/ado';
import {
  releaseTaskRun,
  resolveTaskCommitAuthor,
} from '@roomote/cloud-agents/server';

import { withBootstrapFailureSignal } from '../../../bootstrap-failure-signal';
import { notifySourceRunOnSettle } from './notify-source-run-on-settle';

/**
 * Resolved git author identity for commits made by the worker.
 */
export interface GitAuthor {
  name: string;
  email: string;
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Strips control-plane / provider / instance secrets from an agent-facing env
 * var map, even if an operator stored them in the `environment_variables`
 * table. The control plane reads these by name via `resolveDeploymentEnvVar`
 * (a separate path), so stripping them does not affect provisioning. Uses the
 * shared {@link CONTROL_PLANE_ENV_VAR_NAMES} set that also drives the
 * environment-variables editor's reservation, so the two cannot drift apart.
 */
export function redactControlPlaneEnvVars(
  envVars: Record<string, string>,
): Record<string, string> {
  const hasControlPlaneSecret = Object.keys(envVars).some((name) =>
    CONTROL_PLANE_ENV_VAR_NAMES.has(name),
  );

  if (!hasControlPlaneSecret) {
    return envVars;
  }

  const nextEnvVars = { ...envVars };
  for (const name of CONTROL_PLANE_ENV_VAR_NAMES) {
    delete nextEnvVars[name];
  }

  return nextEnvVars;
}

export function redactSourceControlProviderEnvVars(
  envVars: Record<string, string>,
  sourceControlProvider?: SourceControlProvider,
): Record<string, string> {
  if (sourceControlProvider === 'github') {
    return envVars;
  }

  const providerTokenEnvVars =
    sourceControlProvider === 'gitlab'
      ? ['GITLAB_TOKEN']
      : sourceControlProvider === 'gitea'
        ? ['GITEA_TOKEN']
        : sourceControlProvider === 'bitbucket'
          ? []
          : sourceControlProvider === 'ado'
            ? ['ADO_TOKEN']
            : [];
  const shouldRedact = providerTokenEnvVars.some(
    (envVar) => envVars[envVar] !== undefined,
  );

  if (!shouldRedact) {
    return envVars;
  }

  const nextEnvVars = { ...envVars };

  for (const envVar of providerTokenEnvVars) {
    delete nextEnvVars[envVar];
  }

  return nextEnvVars;
}

/**
 * Returns a SQL query to claim a specific task run by ID.
 */
export function claimJobById(runId: number) {
  return sql`
    UPDATE task_runs SET status = ${RunStatus.Processing} WHERE id = (
      SELECT id FROM task_runs
      WHERE id = ${runId} AND status = ${RunStatus.Dequeued}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
}

/**
 * Fetches and decrypts deployment environment variables.
 */
export async function fetchEnvVars(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  options?: {
    sourceControlProvider?: SourceControlProvider;
  },
): Promise<Record<string, string>> {
  const encryptedEnvVars = await tx.query.environmentVariables.findMany();

  const decrypted = await Promise.all(
    encryptedEnvVars.map(async ({ name, value }) => ({
      name,
      value: await decryptSecrets<string>(value),
    })),
  );

  const envVars = decrypted
    .filter(
      (item): item is { name: string; value: string } => item.value !== null,
    )
    .reduce(
      (acc, { name, value }) => ({
        [name]: stringifyDecryptedEnvVarValue(value),
        ...acc,
      }),
      {} as Record<string, string>,
    );

  return redactControlPlaneEnvVars(
    redactSourceControlProviderEnvVars(envVars, options?.sourceControlProvider),
  );
}

/**
 * Legacy aliases for workers frozen inside sandbox snapshots created before
 * the R_* env rename: those builds read the old ROOMOTE_* names from the
 * task env delivered at dequeue/resume. Applied only to worker-bound env.
 * Remove once pre-rename snapshots have aged out (see the matching
 * ROOMOTE_APP_URL alias in @roomote/compute-providers worker-env).
 */
const LEGACY_MODEL_RUNTIME_ENV_ALIASES: Record<string, string> = {
  R_MODEL: 'ROOMOTE_MODEL',
  R_SMALL_MODEL: 'ROOMOTE_SMALL_MODEL',
  R_VISION_MODEL: 'ROOMOTE_VISION_MODEL',
  R_CODE_REVIEW_MODEL: 'ROOMOTE_CODE_REVIEW_MODEL',
  R_EXPLORE_MODEL: 'ROOMOTE_EXPLORE_MODEL',
  R_PLANNING_MODEL: 'ROOMOTE_PLANNING_MODEL',
  R_MODEL_REASONING_EFFORT: 'ROOMOTE_MODEL_REASONING_EFFORT',
  R_SMALL_MODEL_REASONING_EFFORT: 'ROOMOTE_SMALL_MODEL_REASONING_EFFORT',
  R_VISION_MODEL_REASONING_EFFORT: 'ROOMOTE_VISION_MODEL_REASONING_EFFORT',
  R_CODE_REVIEW_MODEL_REASONING_EFFORT:
    'ROOMOTE_CODE_REVIEW_MODEL_REASONING_EFFORT',
  R_EXPLORE_MODEL_REASONING_EFFORT: 'ROOMOTE_EXPLORE_MODEL_REASONING_EFFORT',
  R_PLANNING_MODEL_REASONING_EFFORT: 'ROOMOTE_PLANNING_MODEL_REASONING_EFFORT',
  R_MODEL_ENV_KEYS: 'ROOMOTE_MODEL_ENV_KEYS',
};

function withLegacySnapshotModelEnvAliases(
  env: Record<string, string>,
): Record<string, string> {
  const aliased = { ...env };

  for (const [canonical, legacy] of Object.entries(
    LEGACY_MODEL_RUNTIME_ENV_ALIASES,
  )) {
    const value = aliased[canonical];

    if (value !== undefined && aliased[legacy] === undefined) {
      aliased[legacy] = value;
    }
  }

  return aliased;
}

export async function fetchResolvedRuntimeEnvVars(
  deploymentEnvVars?: Record<string, string>,
  options?: {
    sourceControlProvider?: SourceControlProvider;
  },
): Promise<Record<string, string>> {
  const envVars =
    deploymentEnvVars ?? (await loadPersistedDeploymentEnvVarsFromDb());
  const resolvedModelRuntimeEnv = await resolveEffectiveModelRuntimeEnv({
    deploymentEnvVars: envVars,
  });

  return redactControlPlaneEnvVars(
    redactSourceControlProviderEnvVars(
      withLegacySnapshotModelEnvAliases({
        ...envVars,
        ...resolvedModelRuntimeEnv,
      }),
      options?.sourceControlProvider,
    ),
  );
}

async function loadPersistedDeploymentEnvVarsFromDb(): Promise<
  Record<string, string>
> {
  const encryptedEnvVars = await db.query.environmentVariables.findMany();

  const decrypted = await Promise.all(
    encryptedEnvVars.map(async ({ name, value }) => ({
      name,
      value: await decryptSecrets<string>(value),
    })),
  );

  return decrypted
    .filter(
      (item): item is { name: string; value: string } => item.value !== null,
    )
    .reduce(
      (acc, { name, value }) => {
        acc[name] = stringifyDecryptedEnvVarValue(value);
        return acc;
      },
      {} as Record<string, string>,
    );
}

/**
 * Cancels a task run with an error message and releases its task lock.
 */
export async function cancelAndReleaseTaskRun(
  taskRun: TaskRun,
  errorMessage: string,
  logPrefix: string,
): Promise<void> {
  const endedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(taskRuns)
      .set({
        status: RunStatus.Canceled,
        canceledAt: endedAt,
        error: errorMessage,
      })
      .where(eq(taskRuns.id, taskRun.id));

    // Derive the owning task's state from all its runs. finishRun never
    // runs for runs canceled before/at dequeue, so without this sync the task
    // would stay 'active' forever. The shared helper deprioritizes this
    // never-started cancel, so an earlier completed sibling still wins.
    await syncTaskStateFromRuns(tx, taskRun.taskId);

    await markTaskStartParallelCountEndedAt(tx, {
      runId: taskRun.id,
      endedAt,
    });
  });

  try {
    await releaseTaskRun(taskRun);
  } catch (error) {
    console.error(
      `${logPrefix} Failed to release lock for run ${taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await notifyCanceledTaskRunOnSettle(taskRun, errorMessage);
}

/**
 * Dequeue/bootstrap cancellations bypass finishRun, so they must explicitly
 * deliver notify-on-settle feedback after their transaction commits.
 */
export async function notifyCanceledTaskRunOnSettle(
  taskRun: TaskRun,
  errorMessage?: string,
): Promise<void> {
  try {
    const persistedRun = errorMessage
      ? null
      : await db.query.taskRuns.findFirst({
          where: eq(taskRuns.id, taskRun.id),
          columns: { error: true },
        });
    const taskTitle = (taskRun as TaskRun & { task?: { title: string | null } })
      .task?.title;

    await notifySourceRunOnSettle(
      {
        ...taskRun,
        error: errorMessage ?? persistedRun?.error ?? taskRun.error,
      },
      RunStatus.Canceled,
      taskTitle,
    );
  } catch (error) {
    console.error(
      `[notifyCanceledTaskRunOnSettle] Failed for run ${taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const SOURCE_CONTROL_TOKEN_MAX_RETRIES = 3;
const SOURCE_CONTROL_TOKEN_BASE_DELAY_MS = 1_000;

export type SourceControlRuntimeToken = SourceControlTokenMetadata & {
  source: 'user' | 'app';
  expiresAt: Date | null;
  artifactsPatch?: Record<string, unknown>;
};

/**
 * Resolve the provider for a run's source-control token. Prefers the explicit
 * payload stamp; when absent, resolves from the synced repositories the
 * workspace references, so non-GitHub deployments work even when a launch
 * site forgot to stamp the payload. Falls back to the GitHub default only
 * when the workspace repositories are unknown or span providers.
 */
async function resolveTaskRunSourceControlProvider(
  taskRun: Pick<TaskRun, 'payload'>,
): Promise<SourceControlProvider> {
  const payload = taskRun.payload as { sourceControlProvider?: unknown };

  if (
    payload.sourceControlProvider !== undefined &&
    payload.sourceControlProvider !== null &&
    payload.sourceControlProvider !== ''
  ) {
    return resolveSourceControlProviderFromPayload(payload);
  }

  // No explicit stamp: resolve from the workspace's synced repositories via the
  // shared resolver (covers every workspace shape). It returns undefined when
  // the provider is ambiguous or unknown, in which case fall back to the
  // GitHub default that resolveSourceControlProviderFromPayload applies.
  const workspace = resolveTaskWorkspace(taskRun.payload);
  const resolvedProvider = await resolveWorkspaceSourceControlProvider(
    db,
    workspace,
  );

  if (resolvedProvider) {
    return resolvedProvider;
  }

  return resolveSourceControlProviderFromPayload(taskRun.payload);
}

async function createProviderToken(
  taskRun: TaskRun,
): Promise<SourceControlRuntimeToken> {
  const provider = await resolveTaskRunSourceControlProvider(taskRun);

  switch (provider) {
    case 'github': {
      const token = await createTaskRunWorkerGitHubToken(taskRun);
      return {
        ...buildSourceControlTokenMetadata(provider, token),
        source: 'app',
        expiresAt: null,
      };
    }
    case 'gitlab': {
      const scopedTokens = await createTaskRunScopedGitLabTokens(taskRun);

      return {
        provider,
        token: scopedTokens.credentials[0]?.token ?? '',
        envVar: 'GITLAB_TOKEN',
        envVars: {},
        gitCredentials: scopedTokens.credentials,
        gitProxyCredentials: scopedTokens.proxyCredentials.map(
          (credential) => ({
            ...credential,
            provider,
          }),
        ),
        source: 'app',
        expiresAt: null,
        artifactsPatch: scopedTokens.artifactsPatch,
      };
    }
    case 'gitea': {
      const credentials = await createTaskRunGiteaCredentials(taskRun);

      return {
        provider,
        token: '',
        envVar: 'GITEA_TOKEN',
        envVars: {},
        gitProxyCredentials: credentials.credentials.map((credential) => ({
          ...credential,
          provider,
        })),
        source: 'app',
        expiresAt: null,
      };
    }
    case 'bitbucket': {
      const credentials = await createTaskRunBitbucketCredentials(taskRun);

      return {
        provider,
        token: '',
        envVar: 'BITBUCKET_OAUTH',
        envVars: {},
        gitProxyCredentials: credentials.credentials.map((credential) => ({
          ...credential,
          provider,
        })),
        source: 'app',
        expiresAt: null,
      };
    }
    case 'ado': {
      const credentials = await createTaskRunAdoCredentials(taskRun);

      return {
        provider,
        token: '',
        envVar: 'ADO_TOKEN',
        envVars: {},
        gitProxyCredentials: credentials.credentials.map((credential) => ({
          ...credential,
          provider,
        })),
        source: 'app',
        expiresAt: null,
      };
    }
  }
}

/**
 * Creates a source-control token for the task run with retry logic.
 * Retries up to {@link SOURCE_CONTROL_TOKEN_MAX_RETRIES} times with
 * exponential backoff (1s, 2s, 4s) to handle transient provider API failures.
 * Returns null if all attempts fail (caller should handle the error).
 */
export async function createSourceControlTokenForTaskRun(
  taskRun: TaskRun,
  logPrefix: string,
  {
    maxRetries = SOURCE_CONTROL_TOKEN_MAX_RETRIES,
    baseDelayMs = SOURCE_CONTROL_TOKEN_BASE_DELAY_MS,
  } = {},
): Promise<SourceControlRuntimeToken | null> {
  const provider = await resolveTaskRunSourceControlProvider(taskRun);
  const label = getSourceControlProviderLabel(provider);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await createProviderToken(taskRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * 2 ** (attempt - 1);
        console.warn(
          `${logPrefix} ${label} token creation attempt ${attempt}/${maxRetries} failed for task run ${taskRun.id}: ${message}. Retrying in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        console.error(
          `${logPrefix} Failed to create ${label} token for task run ${taskRun.id} after ${maxRetries} attempts: ${message}`,
        );
      }
    }
  }

  return null;
}

/**
 * Marks a task run as canceled with an error message.
 */
export async function cancelTaskRun(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  runId: number,
  error: string,
  options?: {
    bootstrapFailureReason?: string;
    existingArtifacts?: TaskRun['artifacts'];
  },
): Promise<void> {
  const artifacts = options?.bootstrapFailureReason
    ? withBootstrapFailureSignal(
        options.existingArtifacts,
        options.bootstrapFailureReason,
      )
    : undefined;
  const endedAt = new Date();

  await tx
    .update(taskRuns)
    .set({
      status: RunStatus.Canceled,
      canceledAt: endedAt,
      error,
      ...(artifacts ? { artifacts } : {}),
    })
    .where(eq(taskRuns.id, runId));

  // Derive the owning task's state from all its runs. This runs on the dequeue
  // path (invalid run, bootstrap failure) where finishRun never executes,
  // so the task must be resolved here or it stays 'active' forever. The caller
  // only has the run id, so resolve the task via the run row, then sync.
  const [runRow] = await tx
    .select({ taskId: taskRuns.taskId })
    .from(taskRuns)
    .where(eq(taskRuns.id, runId));

  if (runRow) {
    await syncTaskStateFromRuns(tx, runRow.taskId);
  }

  await markTaskStartParallelCountEndedAt(tx, {
    runId: runId,
    endedAt,
  });
}

/**
 * Reports an immediate dequeue bootstrap failure without letting the callback
 * break the dequeue transaction path.
 */
export function reportBootstrapFailure({
  callback,
  error,
  taskRun,
  logPrefix,
}: {
  callback?: (error: Error, taskRun: TaskRun) => void;
  error: Error;
  taskRun: TaskRun;
  logPrefix: string;
}): void {
  try {
    callback?.(error, taskRun);
  } catch (callbackError) {
    console.error(
      `${logPrefix} onBootstrapFailure failed for task run ${taskRun.id}: ${
        callbackError instanceof Error
          ? callbackError.message
          : String(callbackError)
      }`,
    );
  }
}

export async function resolveGitAuthor(
  tx: DbTx,
  taskRun: Pick<TaskRun, 'id' | 'taskId'>,
): Promise<GitAuthor> {
  const task = await tx.query.tasks.findFirst({
    where: eq(tasks.id, taskRun.taskId),
    columns: {
      commitAuthorKind: true,
      commitAuthorUserId: true,
      commitAuthorLogin: true,
      commitAuthorExternalId: true,
      prAssigneeLogin: true,
      actorDisplayName: true,
    },
  });

  if (!task) {
    throw new Error(
      `Task ${taskRun.taskId} not found while resolving the git author for run ${taskRun.id}.`,
    );
  }

  const commitAuthor = await resolveTaskCommitAuthor(tx, task);

  return commitAuthor.gitAuthor;
}
