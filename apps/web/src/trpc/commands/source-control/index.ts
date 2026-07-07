import { randomBytes } from 'node:crypto';

import * as Ado from '@roomote/ado';
import * as Gitea from '@roomote/gitea';
import * as GitLab from '@roomote/gitlab';
import {
  buildSetupSourceControlStatus,
  getSetupSourceControlProvider,
  isLoopbackHostname,
  type SetupSourceControlProviderStatus,
  type SetupSourceControlStatus,
  type PrAction,
  type SourceControlProvider,
  type SourceControlTokenBackedProvider,
} from '@roomote/types';
import {
  db,
  environmentRepositoryMappings,
  environmentVariables,
  getDeploymentPrAction,
  resolveDeploymentEnvVar,
  setDeploymentPrAction,
  type DatabaseOrTransaction,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { getRepositories } from '@/lib/server';
import { Env } from '@/lib/server/env';

import {
  assertAdmin,
  upsertDeploymentEnvironmentVariables,
} from '../environment-variables';

export async function getRepositoriesCommand(
  auth: UserAuthSuccess,
  input?: {
    includeEmptyState?: boolean;
    sourceControlProvider?: SourceControlProvider;
  },
) {
  if (input?.includeEmptyState) {
    return getRepositories(auth, {
      includeEmptyState: true,
      sourceControlProvider: input.sourceControlProvider,
    });
  }

  return getRepositories(auth, {
    sourceControlProvider: input?.sourceControlProvider,
  });
}

export async function getSourceControlConfigStatusCommand(
  auth: UserAuthSuccess,
): Promise<SetupSourceControlStatus> {
  assertAdmin(auth);

  const persistedEnvVarNames = await getPersistedEnvironmentVariableNames();
  const gitlabBaseUrl = await resolveDeploymentEnvVar('GITLAB_BASE_URL');

  return buildSetupSourceControlStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames,
    gitlabBaseUrl,
  });
}

/**
 * Webhooks are only auto-created for synced repositories that are mapped to
 * at least one environment. Hooking every project the deployment token can
 * administer leaks events from unrelated repositories (for example private
 * work projects visible to a personal PAT) to the Roomote URL, so sync
 * treats environment mappings as the operator's selection and removes the
 * Roomote webhook from synced-but-unmapped repositories.
 */
async function getEnvironmentMappedRepositoryIds(): Promise<Set<string>> {
  const mappingRows = await db
    .select({ repositoryId: environmentRepositoryMappings.repositoryId })
    .from(environmentRepositoryMappings);

  return new Set(mappingRows.map((mapping) => mapping.repositoryId));
}

/**
 * Shared summary shape returned by every provider webhook-setup flow. Each
 * provider's `configureXWebhooks` wrapper reuses
 * {@link configureScopedProviderWebhooks} and narrows `failed` to its own
 * per-provider ensure-result type.
 */
type WebhookSetupSummary<TFailed> =
  | {
      status: 'configured';
      created: number;
      updated: number;
      failed: TFailed[];
      skippedUnmapped: number;
      removed: number;
    }
  | { status: 'skipped'; reason: string };

type GitLabWebhookSetupSummary =
  WebhookSetupSummary<GitLab.GitLabWebhookEnsureResult>;
type GiteaWebhookSetupSummary =
  WebhookSetupSummary<Gitea.GiteaWebhookEnsureResult>;
type AdoWebhookSetupSummary =
  WebhookSetupSummary<Ado.AdoServiceHookEnsureResult>;

/**
 * Owns the single source of truth for scoping a provider's webhook setup to
 * environment-mapped repositories: the mapped/unmapped split via
 * {@link getEnvironmentMappedRepositoryIds}, the provider-specific target
 * projection ({@link toTarget}), the best-effort unmapped-removal with a
 * `.catch(->[])` fallback that only warns, the `removed`/`skippedUnmapped`
 * accounting, and the {@link WebhookSetupSummary} shape. Each
 * `configureXWebhooks` wrapper shrinks to its loopback-URL skip check plus a
 * call into this helper, so the unmapped-removal policy lives in one place
 * instead of three near-identical orchestration blocks.
 */
async function configureScopedProviderWebhooks<
  TRepository extends { id: string },
  TTarget,
  TRemoveResult extends { status: string },
  TEnsureResult extends { status: 'created' | 'updated' | 'failed' },
>(params: {
  webhookUrl: string;
  repositories: TRepository[];
  toTarget: (repository: TRepository) => TTarget[];
  removeWebhooks: (args: {
    targets: TTarget[];
    webhookUrl: string;
  }) => Promise<TRemoveResult[]>;
  ensureWebhooks: (args: {
    targets: TTarget[];
    webhookUrl: string;
    secretToken: string;
  }) => Promise<TEnsureResult[]>;
  resolveSecretToken: (actorUserId: string) => Promise<string>;
  actorUserId: string;
  logPrefix: string;
  removalDescription: string;
}): Promise<WebhookSetupSummary<TEnsureResult>> {
  const mappedRepositoryIds = await getEnvironmentMappedRepositoryIds();
  const mappedTargets = params.repositories
    .filter((repository) => mappedRepositoryIds.has(repository.id))
    .flatMap(params.toTarget);
  const unmappedTargets = params.repositories
    .filter((repository) => !mappedRepositoryIds.has(repository.id))
    .flatMap(params.toTarget);

  const removals =
    unmappedTargets.length > 0
      ? await params
          .removeWebhooks({
            targets: unmappedTargets,
            webhookUrl: params.webhookUrl,
          })
          .catch((error: unknown) => {
            console.warn(
              `${params.logPrefix} Failed to ${params.removalDescription}:`,
              error,
            );
            return [];
          })
      : [];
  const removed = removals.filter(
    (result) => result.status === 'removed',
  ).length;

  if (mappedTargets.length === 0) {
    return {
      status: 'configured',
      created: 0,
      updated: 0,
      failed: [],
      skippedUnmapped: unmappedTargets.length,
      removed,
    };
  }

  const secretToken = await params.resolveSecretToken(params.actorUserId);
  const results = await params.ensureWebhooks({
    targets: mappedTargets,
    webhookUrl: params.webhookUrl,
    secretToken,
  });

  return {
    status: 'configured',
    created: results.filter((result) => result.status === 'created').length,
    updated: results.filter((result) => result.status === 'updated').length,
    failed: results.filter((result) => result.status === 'failed'),
    skippedUnmapped: unmappedTargets.length,
    removed,
  };
}

function getSourceControlWebhookUrl(
  provider: 'gitlab' | 'gitea' | 'ado',
): string | null {
  // Match the GitHub App manifest behavior: prefer TRPC_URL, but fall back
  // to ROOMOTE_APP_URL when TRPC_URL is a loopback address that token-backed
  // source-control providers cannot reach.
  const trpcUrl = new URL(Env.TRPC_URL);
  const webhookBaseUrl = isLoopbackHostname(trpcUrl.hostname)
    ? Env.ROOMOTE_APP_URL
    : Env.TRPC_URL;

  if (isLoopbackHostname(new URL(webhookBaseUrl).hostname)) {
    return null;
  }

  return new URL(`/api/webhooks/${provider}`, webhookBaseUrl).toString();
}

async function resolveOrCreateGitLabWebhookSecret(
  actorUserId: string,
): Promise<string> {
  const existingSecret = await resolveDeploymentEnvVar('GITLAB_WEBHOOK_SECRET');

  if (existingSecret?.trim()) {
    return existingSecret.trim();
  }

  const generatedSecret = randomBytes(32).toString('hex');

  await upsertDeploymentEnvironmentVariables(db, {
    userId: actorUserId,
    values: [{ name: 'GITLAB_WEBHOOK_SECRET', value: generatedSecret }],
  });

  return generatedSecret;
}

async function configureGitLabWebhooks(
  actorUserId: string,
  repositories: {
    id: string;
    externalRepoId: string | null;
    fullName: string;
  }[],
): Promise<GitLabWebhookSetupSummary> {
  const webhookUrl = getSourceControlWebhookUrl('gitlab');

  if (!webhookUrl) {
    return {
      status: 'skipped',
      reason:
        'No publicly reachable Roomote URL is configured, so GitLab webhooks were not set up.',
    };
  }

  return configureScopedProviderWebhooks({
    webhookUrl,
    repositories,
    toTarget: (repository) =>
      repository.externalRepoId?.trim()
        ? [
            {
              projectId: repository.externalRepoId,
              repositoryFullName: repository.fullName,
            },
          ]
        : [],
    removeWebhooks: ({ targets, webhookUrl }) =>
      GitLab.removeGitLabWebhooksForProjects({
        projects: targets,
        webhookUrl,
      }),
    ensureWebhooks: ({ targets, webhookUrl, secretToken }) =>
      GitLab.ensureGitLabWebhooksForProjects({
        projects: targets,
        webhookUrl,
        secretToken,
      }),
    resolveSecretToken: resolveOrCreateGitLabWebhookSecret,
    actorUserId,
    logPrefix: '[configureGitLabWebhooks]',
    removalDescription: 'remove webhooks from unmapped projects',
  });
}

async function resolveOrCreateGiteaWebhookSecret(
  actorUserId: string,
): Promise<string> {
  const existingSecret = await resolveDeploymentEnvVar('GITEA_WEBHOOK_SECRET');

  if (existingSecret?.trim()) {
    return existingSecret.trim();
  }

  const generatedSecret = randomBytes(32).toString('hex');

  await upsertDeploymentEnvironmentVariables(db, {
    userId: actorUserId,
    values: [{ name: 'GITEA_WEBHOOK_SECRET', value: generatedSecret }],
  });

  return generatedSecret;
}

async function configureGiteaWebhooks(
  actorUserId: string,
  repositories: { id: string; fullName: string }[],
): Promise<GiteaWebhookSetupSummary> {
  const webhookUrl = getSourceControlWebhookUrl('gitea');

  if (!webhookUrl) {
    return {
      status: 'skipped',
      reason:
        'No publicly reachable Roomote URL is configured, so Gitea webhooks were not set up.',
    };
  }

  return configureScopedProviderWebhooks({
    webhookUrl,
    repositories,
    toTarget: (repository) => [{ repositoryFullName: repository.fullName }],
    removeWebhooks: ({ targets, webhookUrl }) =>
      Gitea.removeGiteaWebhooksForRepositories({
        repositories: targets,
        webhookUrl,
      }),
    ensureWebhooks: ({ targets, webhookUrl, secretToken }) =>
      Gitea.ensureGiteaWebhooksForRepositories({
        repositories: targets,
        webhookUrl,
        secretToken,
      }),
    resolveSecretToken: resolveOrCreateGiteaWebhookSecret,
    actorUserId,
    logPrefix: '[configureGiteaWebhooks]',
    removalDescription: 'remove webhooks from unmapped repositories',
  });
}

async function resolveOrCreateAdoWebhookSecret(
  actorUserId: string,
): Promise<string> {
  const existingSecret = await resolveDeploymentEnvVar('ADO_WEBHOOK_SECRET');

  if (existingSecret?.trim()) {
    return existingSecret.trim();
  }

  const generatedSecret = randomBytes(32).toString('hex');

  await upsertDeploymentEnvironmentVariables(db, {
    userId: actorUserId,
    values: [{ name: 'ADO_WEBHOOK_SECRET', value: generatedSecret }],
  });

  return generatedSecret;
}

function getAdoProjectId(permissions: unknown): string | null {
  if (typeof permissions !== 'object' || permissions === null) {
    return null;
  }

  const projectId = (permissions as { projectId?: unknown }).projectId;
  return typeof projectId === 'string' && projectId.trim() ? projectId : null;
}

async function configureAdoWebhooks(
  actorUserId: string,
  repositories: {
    id: string;
    externalRepoId: string | null;
    fullName: string;
    permissions: unknown;
  }[],
): Promise<AdoWebhookSetupSummary> {
  const webhookUrl = getSourceControlWebhookUrl('ado');

  if (!webhookUrl) {
    return {
      status: 'skipped',
      reason:
        'No publicly reachable Roomote URL is configured, so Azure DevOps service hooks were not set up.',
    };
  }

  return configureScopedProviderWebhooks({
    webhookUrl,
    repositories,
    toTarget: (repository) => {
      const repositoryId = repository.externalRepoId?.trim();
      const projectId = getAdoProjectId(repository.permissions);

      return repositoryId && projectId
        ? [
            {
              repositoryFullName: repository.fullName,
              repositoryId,
              projectId,
            },
          ]
        : [];
    },
    removeWebhooks: ({ targets, webhookUrl }) =>
      Ado.removeAdoServiceHooksForRepositories({
        repositories: targets,
        webhookUrl,
      }),
    ensureWebhooks: ({ targets, webhookUrl, secretToken }) =>
      Ado.ensureAdoServiceHooksForRepositories({
        repositories: targets,
        webhookUrl,
        secretToken,
      }),
    resolveSecretToken: resolveOrCreateAdoWebhookSecret,
    actorUserId,
    logPrefix: '[configureAdoWebhooks]',
    removalDescription: 'remove service hooks from unmapped repositories',
  });
}

export async function syncRepositoriesCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SourceControlTokenBackedProvider;
  },
) {
  try {
    assertAdmin(auth);

    switch (input.provider) {
      case 'gitlab': {
        const syncResult = await GitLab.syncGitLabRepositories({
          userId: auth.userId,
        });

        // Webhook setup failures should not fail the sync: repositories are
        // usable for manual launches even when webhooks could not be
        // created (for example a token identity below Maintainer).
        const webhooks = await configureGitLabWebhooks(
          auth.userId,
          syncResult.repositories,
        ).catch(
          (error: unknown): GitLabWebhookSetupSummary => ({
            status: 'skipped',
            reason: error instanceof Error ? error.message : String(error),
          }),
        );

        return { ...syncResult, webhooks };
      }
      case 'gitea': {
        const syncResult = await Gitea.syncGiteaRepositories({
          userId: auth.userId,
        });

        const webhooks = await configureGiteaWebhooks(
          auth.userId,
          syncResult.repositories,
        ).catch(
          (error: unknown): GiteaWebhookSetupSummary => ({
            status: 'skipped',
            reason: error instanceof Error ? error.message : String(error),
          }),
        );

        return { ...syncResult, webhooks };
      }
      case 'ado': {
        const syncResult = await Ado.syncAdoRepositories({
          userId: auth.userId,
        });

        const webhooks = await configureAdoWebhooks(
          auth.userId,
          syncResult.repositories,
        ).catch(
          (error: unknown): AdoWebhookSetupSummary => ({
            status: 'skipped',
            reason: error instanceof Error ? error.message : String(error),
          }),
        );

        return { ...syncResult, webhooks };
      }
    }
  } catch (error) {
    console.error(
      `[syncRepositoriesCommand:${input.provider}] Unhandled error:`,
      error,
    );

    return {
      success: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getPrActionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  return { prAction: await getDeploymentPrAction() };
}

export async function setPrActionCommand(
  auth: UserAuthSuccess,
  input: { prAction: PrAction },
) {
  assertAdmin(auth);

  return { prAction: await setDeploymentPrAction(input.prAction) };
}

async function getPersistedEnvironmentVariableNames(
  executor: DatabaseOrTransaction = db,
): Promise<string[]> {
  const envVarRows = await executor
    .select({ name: environmentVariables.name })
    .from(environmentVariables);

  return envVarRows.map((envVar) => envVar.name);
}

export async function saveSourceControlConfigValues(params: {
  executor: DatabaseOrTransaction;
  actorUserId: string;
  provider: SourceControlProvider;
  values?: Partial<Record<string, string>>;
}): Promise<SetupSourceControlProviderStatus> {
  const provider = getSetupSourceControlProvider(params.provider);
  const persistedEnvVarNames = await getPersistedEnvironmentVariableNames(
    params.executor,
  );
  const sourceControlSetup = buildSetupSourceControlStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames,
    selectedProvider: params.provider,
  });
  const providerStatus = sourceControlSetup.providers.find(
    (candidate) => candidate.provider === params.provider,
  );

  if (!providerStatus) {
    throw new Error('Selected source-control provider is unavailable.');
  }

  const valuesToSave = providerStatus.fields.flatMap((field) => {
    const nextValue = params.values?.[field.envVarName]?.trim() ?? '';

    if (!nextValue) {
      return [];
    }

    return [
      {
        name: field.envVarName,
        value: nextValue,
      },
    ];
  });

  const hasMissingRequiredValue = providerStatus.fields.some((field) => {
    const nextValue = params.values?.[field.envVarName]?.trim() ?? '';

    return (
      field.required !== false &&
      !field.runtimeSatisfied &&
      !field.savedSatisfied &&
      nextValue.length === 0
    );
  });

  if (hasMissingRequiredValue) {
    throw new Error(
      `Enter the required ${provider.label} configuration values to continue.`,
    );
  }

  if (valuesToSave.length > 0) {
    await upsertDeploymentEnvironmentVariables(params.executor, {
      userId: params.actorUserId,
      values: valuesToSave,
    });
  }

  return providerStatus;
}

/**
 * Validates provider config values that can be checked against the provider
 * API before persisting. Called by config-save commands BEFORE they open a
 * database transaction so the external HTTP round-trip never holds a pooled
 * connection open.
 */
export async function assertValidSourceControlConfigInput(params: {
  provider: SourceControlProvider;
  values?: Partial<Record<string, string>>;
}): Promise<void> {
  const nextGitLabToken =
    params.provider === 'gitlab'
      ? params.values?.['GITLAB_TOKEN']?.trim()
      : undefined;
  const nextGiteaToken =
    params.provider === 'gitea'
      ? params.values?.['GITEA_TOKEN']?.trim()
      : undefined;

  if (nextGitLabToken) {
    const validation = await GitLab.validateGitLabToken({
      token: nextGitLabToken,
    });

    if (validation.status === 'invalid') {
      throw new Error(validation.error);
    }
  }

  if (nextGiteaToken) {
    const nextGiteaBaseUrl =
      params.values?.['GITEA_BASE_URL']?.trim() ??
      (await Gitea.resolveGiteaBaseUrl());

    if (!nextGiteaBaseUrl) {
      return;
    }

    const validation = await Gitea.validateGiteaToken({
      token: nextGiteaToken,
      baseUrl: nextGiteaBaseUrl,
    });

    if (validation.status === 'invalid') {
      throw new Error(validation.error);
    }
  }
}

export async function saveSourceControlConfigCommand(
  auth: UserAuthSuccess,
  input: {
    provider: SourceControlProvider;
    values?: Partial<Record<string, string>>;
  },
) {
  assertAdmin(auth);

  await assertValidSourceControlConfigInput(input);

  return db.transaction(async (tx) => {
    const providerStatus = await saveSourceControlConfigValues({
      executor: tx,
      actorUserId: auth.userId,
      provider: input.provider,
      values: input.values,
    });

    return {
      success: true as const,
      provider: input.provider,
      configSatisfied: providerStatus.configSatisfied,
    };
  });
}
