import {
  CONTROL_PLANE_ENV_VAR_NAMES,
  CloudTaskStatus,
  buildSourceControlTokenMetadata,
  getSourceControlProviderLabel,
  resolveCloudTaskWorkspace,
  resolveSourceControlProviderFromPayload,
  type SourceControlProvider,
  type SourceControlTokenMetadata,
} from '@roomote/types';
import {
  type CloudJob,
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
import { createCloudJobWorkerGitHubToken } from '@roomote/github';
import { createCloudJobScopedGitLabTokens } from '@roomote/gitlab';
import { createCloudJobGiteaCredentials } from '@roomote/gitea';
import { createCloudJobAdoCredentials } from '@roomote/ado';
import {
  releaseCloudTask,
  resolveTaskCommitAuthor,
} from '@roomote/cloud-agents/server';

import { withBootstrapFailureSignal } from '../../../bootstrap-failure-signal';

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
export function claimJobById(cloudJobId: number) {
  return sql`
    UPDATE task_runs SET status = ${CloudTaskStatus.Processing} WHERE id = (
      SELECT id FROM task_runs
      WHERE id = ${cloudJobId} AND status = ${CloudTaskStatus.Dequeued}
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
      {
        ...envVars,
        ...resolvedModelRuntimeEnv,
      },
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
 * Cancels a cloud job with an error message and releases its cloud task lock.
 */
export async function cancelAndReleaseCloudJob(
  cloudJob: CloudJob,
  errorMessage: string,
  logPrefix: string,
): Promise<void> {
  const endedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(taskRuns)
      .set({
        status: CloudTaskStatus.Canceled,
        canceledAt: endedAt,
        error: errorMessage,
      })
      .where(eq(taskRuns.id, cloudJob.id));

    // Derive the owning task's state from all its runs. finishCloudJob never
    // runs for runs canceled before/at dequeue, so without this sync the task
    // would stay 'active' forever. The shared helper deprioritizes this
    // never-started cancel, so an earlier completed sibling still wins.
    await syncTaskStateFromRuns(tx, cloudJob.taskId);

    await markTaskStartParallelCountEndedAt(tx, {
      runId: cloudJob.id,
      endedAt,
    });
  });

  try {
    await releaseCloudTask(cloudJob);
  } catch (error) {
    console.error(
      `${logPrefix} Failed to release lock for job ${cloudJob.id}: ${
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
 * Resolve the provider for a job's source-control token. Prefers the explicit
 * payload stamp; when absent, resolves from the synced repositories the
 * workspace references, so non-GitHub deployments work even when a launch
 * site forgot to stamp the payload. Falls back to the GitHub default only
 * when the workspace repositories are unknown or span providers.
 */
async function resolveJobSourceControlProvider(
  cloudJob: Pick<CloudJob, 'payload'>,
): Promise<SourceControlProvider> {
  const payload = cloudJob.payload as { sourceControlProvider?: unknown };

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
  const workspace = resolveCloudTaskWorkspace(cloudJob.payload);
  const resolvedProvider = await resolveWorkspaceSourceControlProvider(
    db,
    workspace,
  );

  if (resolvedProvider) {
    return resolvedProvider;
  }

  return resolveSourceControlProviderFromPayload(cloudJob.payload);
}

async function createProviderToken(
  cloudJob: CloudJob,
): Promise<SourceControlRuntimeToken> {
  const provider = await resolveJobSourceControlProvider(cloudJob);

  switch (provider) {
    case 'github': {
      const token = await createCloudJobWorkerGitHubToken(cloudJob);
      return {
        ...buildSourceControlTokenMetadata(provider, token),
        source: 'app',
        expiresAt: null,
      };
    }
    case 'gitlab': {
      const scopedTokens = await createCloudJobScopedGitLabTokens(cloudJob);

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
      const credentials = await createCloudJobGiteaCredentials(cloudJob);

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
    case 'ado': {
      const credentials = await createCloudJobAdoCredentials(cloudJob);

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
 * Creates a source-control token for the cloud job with retry logic.
 * Retries up to {@link SOURCE_CONTROL_TOKEN_MAX_RETRIES} times with
 * exponential backoff (1s, 2s, 4s) to handle transient provider API failures.
 * Returns null if all attempts fail (caller should handle the error).
 */
export async function createSourceControlTokenForJob(
  cloudJob: CloudJob,
  logPrefix: string,
  {
    maxRetries = SOURCE_CONTROL_TOKEN_MAX_RETRIES,
    baseDelayMs = SOURCE_CONTROL_TOKEN_BASE_DELAY_MS,
  } = {},
): Promise<SourceControlRuntimeToken | null> {
  const provider = await resolveJobSourceControlProvider(cloudJob);
  const label = getSourceControlProviderLabel(provider);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await createProviderToken(cloudJob);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * 2 ** (attempt - 1);
        console.warn(
          `${logPrefix} ${label} token creation attempt ${attempt}/${maxRetries} failed for cloud job ${cloudJob.id}: ${message}. Retrying in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        console.error(
          `${logPrefix} Failed to create ${label} token for cloud job ${cloudJob.id} after ${maxRetries} attempts: ${message}`,
        );
      }
    }
  }

  return null;
}

/**
 * Marks a cloud job as canceled with an error message.
 */
export async function cancelCloudJob(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  cloudJobId: number,
  error: string,
  options?: {
    bootstrapFailureReason?: string;
    existingArtifacts?: CloudJob['artifacts'];
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
      status: CloudTaskStatus.Canceled,
      canceledAt: endedAt,
      error,
      ...(artifacts ? { artifacts } : {}),
    })
    .where(eq(taskRuns.id, cloudJobId));

  // Derive the owning task's state from all its runs. This runs on the dequeue
  // path (invalid job, bootstrap failure) where finishCloudJob never executes,
  // so the task must be resolved here or it stays 'active' forever. The caller
  // only has the run id, so resolve the task via the run row, then sync.
  const [runRow] = await tx
    .select({ taskId: taskRuns.taskId })
    .from(taskRuns)
    .where(eq(taskRuns.id, cloudJobId));

  if (runRow) {
    await syncTaskStateFromRuns(tx, runRow.taskId);
  }

  await markTaskStartParallelCountEndedAt(tx, {
    runId: cloudJobId,
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
  cloudJob,
  logPrefix,
}: {
  callback?: (error: Error, cloudJob: CloudJob) => void;
  error: Error;
  cloudJob: CloudJob;
  logPrefix: string;
}): void {
  try {
    callback?.(error, cloudJob);
  } catch (callbackError) {
    console.error(
      `${logPrefix} onBootstrapFailure failed for cloud job ${cloudJob.id}: ${
        callbackError instanceof Error
          ? callbackError.message
          : String(callbackError)
      }`,
    );
  }
}

export async function resolveGitAuthor(
  tx: DbTx,
  cloudJob: Pick<CloudJob, 'id' | 'taskId'>,
): Promise<GitAuthor> {
  const task = await tx.query.tasks.findFirst({
    where: eq(tasks.id, cloudJob.taskId),
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
      `Task ${cloudJob.taskId} not found while resolving the git author for run ${cloudJob.id}.`,
    );
  }

  const commitAuthor = await resolveTaskCommitAuthor(tx, task);

  return commitAuthor.gitAuthor;
}
