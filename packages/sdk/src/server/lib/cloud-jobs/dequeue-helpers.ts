import {
  CONTROL_PLANE_ENV_VAR_NAMES,
  CloudTaskStatus,
  buildSourceControlTokenMetadata,
  getSourceControlProviderLabel,
  resolveSourceControlProviderFromPayload,
  type SourceControlProvider,
  type SourceControlTokenMetadata,
} from '@roomote/types';
import {
  type CloudJob,
  db,
  cloudJobs,
  markTaskStartParallelCountEndedAt,
  resolveEffectiveModelRuntimeEnv,
  resolveTaskAttribution,
  stringifyDecryptedEnvVarValue,
  eq,
  sql,
} from '@roomote/db/server';
import { decryptSecrets } from '@roomote/db/encryption';
import { createCloudJobWorkerGitHubToken } from '@roomote/github';
import { createCloudJobScopedGitLabTokens } from '@roomote/gitlab';
import { createCloudJobGiteaCredentials } from '@roomote/gitea';
import { createCloudJobAdoCredentials } from '@roomote/ado';
import { releaseCloudTask } from '@roomote/cloud-agents/server';

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
 * Returns a SQL query to claim a specific cloud job by ID.
 */
export function claimJobById(cloudJobId: number) {
  return sql`
    UPDATE cloud_jobs SET status = ${CloudTaskStatus.Processing} WHERE id = (
      SELECT id FROM cloud_jobs
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
      .update(cloudJobs)
      .set({
        status: CloudTaskStatus.Canceled,
        canceledAt: endedAt,
        error: errorMessage,
      })
      .where(eq(cloudJobs.id, cloudJob.id));

    await markTaskStartParallelCountEndedAt(tx, {
      cloudJobId: cloudJob.id,
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

async function createProviderToken(
  cloudJob: CloudJob,
): Promise<SourceControlRuntimeToken> {
  const provider = resolveSourceControlProviderFromPayload(cloudJob.payload);

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
  const provider = resolveSourceControlProviderFromPayload(cloudJob.payload);
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
    .update(cloudJobs)
    .set({
      status: CloudTaskStatus.Canceled,
      canceledAt: endedAt,
      error,
      ...(artifacts ? { artifacts } : {}),
    })
    .where(eq(cloudJobs.id, cloudJobId));

  await markTaskStartParallelCountEndedAt(tx, {
    cloudJobId,
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
  cloudJob: CloudJob,
): Promise<GitAuthor> {
  const attribution = await resolveTaskAttribution(tx, {
    attributionKind: cloudJob.attributionKind,
    attributedUserId: cloudJob.attributedUserId,
    attributionSourceKind: cloudJob.attributionSourceKind,
    attributionSourceDisplayName: cloudJob.attributionSourceDisplayName,
    attributionSourceExternalId: cloudJob.attributionSourceExternalId,
    attributedGithubLogin: cloudJob.attributedGithubLogin,
    attributedGithubUserId: cloudJob.attributedGithubUserId,
    effectiveAuthorKind: cloudJob.effectiveAuthorKind,
    effectiveAuthorUserId: cloudJob.effectiveAuthorUserId,
    effectiveAuthorDisplayName: cloudJob.effectiveAuthorDisplayName,
    effectiveAuthorGithubLogin: cloudJob.effectiveAuthorGithubLogin,
    effectiveAuthorGithubUserId: cloudJob.effectiveAuthorGithubUserId,
    effectiveAuthorReason: cloudJob.effectiveAuthorReason,
    effectiveAuthorRuleId: cloudJob.effectiveAuthorRuleId,
    effectivePrOwnerKind: cloudJob.effectivePrOwnerKind,
    effectivePrOwnerUserId: cloudJob.effectivePrOwnerUserId,
    effectivePrOwnerDisplayName: cloudJob.effectivePrOwnerDisplayName,
    effectivePrOwnerGithubLogin: cloudJob.effectivePrOwnerGithubLogin,
    effectivePrOwnerReason: cloudJob.effectivePrOwnerReason,
    effectivePrOwnerRuleId: cloudJob.effectivePrOwnerRuleId,
  });

  return attribution.gitAuthor;
}
