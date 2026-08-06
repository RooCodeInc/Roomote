import * as Ado from '@roomote/ado';
import * as Bitbucket from '@roomote/bitbucket';
import * as Gitea from '@roomote/gitea';
import * as GitLab from '@roomote/gitlab';
import {
  getSetupSourceControlProvider,
  type SourceControlProvider,
} from '@roomote/types';
import {
  and,
  authAccounts,
  db,
  eq,
  repositories,
  type DatabaseOrTransaction,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import {
  deleteDeploymentEnvironmentVariables,
  getPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues,
} from '../environment-variables';
import { disableGitHubAppCommand } from '../github/mutations';
import {
  getAdoProjectId,
  getSourceControlWebhookUrl,
} from './provider-helpers';

type ClearSourceControlConfigWarning = {
  kind: 'webhook_cleanup' | 'oauth_cleanup';
  repositoryId?: string;
  repositoryFullName?: string;
  message: string;
};

type ClearConfigRepository = {
  id: string;
  externalRepoId: string | null;
  fullName: string;
  permissions: unknown;
};

type HookCleanupResult = {
  status: string;
  repositoryFullName: string;
  error?: string;
};

type ProviderCleanupState = {
  linkedAccountId?: string;
};

type ProviderCleanup = {
  envVarAliases: readonly string[];
  disconnect?: (auth: UserAuthSuccess) => Promise<void>;
  removeHooks?: (
    repositories: ClearConfigRepository[],
    webhookUrl: string,
  ) => Promise<HookCleanupResult[]>;
  removeOAuthConnection?: () => Promise<void>;
  loadState?: () => Promise<ProviderCleanupState>;
  clearLocalState?: (
    tx: DatabaseOrTransaction,
    state: ProviderCleanupState,
  ) => Promise<void>;
};

const providerCleanupRegistry: Record<SourceControlProvider, ProviderCleanup> =
  {
    github: {
      envVarAliases: [],
      disconnect: async (auth) => {
        const result = await disableGitHubAppCommand(auth);
        if (!result.success) {
          throw new Error(result.error);
        }
      },
    },
    gitlab: {
      envVarAliases: ['GITLAB_TOKEN'],
      removeHooks: (providerRepositories, webhookUrl) =>
        GitLab.removeGitLabWebhooksForProjects({
          projects: providerRepositories.flatMap((repository) =>
            repository.externalRepoId?.trim()
              ? [
                  {
                    projectId: repository.externalRepoId,
                    repositoryFullName: repository.fullName,
                  },
                ]
              : [],
          ),
          webhookUrl,
        }),
      removeOAuthConnection: async () => {
        await GitLab.deleteGitLabOAuthConnection();
        GitLab.clearGitLabDeploymentUserCache();
      },
    },
    gitea: {
      envVarAliases: ['GITEA_TOKEN'],
      removeHooks: (providerRepositories, webhookUrl) =>
        Gitea.removeGiteaWebhooksForRepositories({
          repositories: providerRepositories.map((repository) => ({
            repositoryFullName: repository.fullName,
          })),
          webhookUrl,
        }),
      removeOAuthConnection: async () => {
        await Gitea.deleteGiteaOAuthConnection();
        Gitea.clearGiteaDeploymentUserCache();
      },
    },
    bitbucket: {
      envVarAliases: [
        'BITBUCKET_OAUTH',
        'BITBUCKET_TOKEN',
        'BITBUCKET_USERNAME',
      ],
      removeHooks: (providerRepositories, webhookUrl) =>
        Bitbucket.removeBitbucketWebhooksForRepositories({
          repositories: providerRepositories.map((repository) => ({
            repositoryFullName: repository.fullName,
          })),
          webhookUrl,
        }),
      removeOAuthConnection: async () => {
        await Bitbucket.deleteBitbucketOAuthConnection();
        Bitbucket.clearBitbucketDeploymentUserCache();
      },
    },
    ado: {
      envVarAliases: [],
      removeHooks: (providerRepositories, webhookUrl) =>
        Ado.removeAdoServiceHooksForRepositories({
          repositories: providerRepositories.flatMap((repository) => {
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
          }),
          webhookUrl,
        }),
      loadState: async () => {
        const values = await getPersistedEnvironmentVariableValues([
          'ADO_LINKED_ACCOUNT_ID',
        ]);
        return { linkedAccountId: values['ADO_LINKED_ACCOUNT_ID'] };
      },
      clearLocalState: async (tx, state) => {
        if (!state.linkedAccountId) {
          return;
        }

        await tx
          .delete(authAccounts)
          .where(
            and(
              eq(authAccounts.providerId, 'ado'),
              eq(authAccounts.accountId, state.linkedAccountId),
            ),
          );
      },
    },
  };

function cleanupWarning(
  kind: ClearSourceControlConfigWarning['kind'],
  error: unknown,
  repository?: Pick<ClearConfigRepository, 'id' | 'fullName'>,
): ClearSourceControlConfigWarning {
  return {
    kind,
    ...(repository
      ? {
          repositoryId: repository.id,
          repositoryFullName: repository.fullName,
        }
      : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

async function removeProviderHooks(
  provider: Exclude<SourceControlProvider, 'github'>,
  providerCleanup: ProviderCleanup,
  providerRepositories: ClearConfigRepository[],
): Promise<ClearSourceControlConfigWarning[]> {
  if (!providerCleanup.removeHooks || providerRepositories.length === 0) {
    return [];
  }

  const webhookUrl = getSourceControlWebhookUrl(provider);
  if (!webhookUrl) {
    return [
      cleanupWarning(
        'webhook_cleanup',
        new Error(
          'No publicly reachable Roomote URL is configured, so external hooks could not be removed automatically.',
        ),
      ),
    ];
  }

  try {
    const results = await providerCleanup.removeHooks(
      providerRepositories,
      webhookUrl,
    );
    return results.flatMap((result) => {
      if (result.status !== 'failed') {
        return [];
      }
      const repository = providerRepositories.find(
        (candidate) => candidate.fullName === result.repositoryFullName,
      );
      return [
        cleanupWarning(
          'webhook_cleanup',
          new Error(result.error ?? 'External hook cleanup failed.'),
          repository,
        ),
      ];
    });
  } catch (error) {
    return [cleanupWarning('webhook_cleanup', error)];
  }
}

async function removeProviderOAuthConnection(
  providerCleanup: ProviderCleanup,
): Promise<ClearSourceControlConfigWarning[]> {
  if (!providerCleanup.removeOAuthConnection) {
    return [];
  }

  try {
    await providerCleanup.removeOAuthConnection();
    return [];
  } catch (error) {
    return [cleanupWarning('oauth_cleanup', error)];
  }
}

export async function clearSourceControlProviderConfig(
  auth: UserAuthSuccess,
  provider: SourceControlProvider,
) {
  const providerSetup = getSetupSourceControlProvider(provider);
  const providerCleanup = providerCleanupRegistry[provider];
  const envVarNames = [
    ...new Set([
      ...providerSetup.fields.flatMap((field) => field.acceptedEnvVarNames),
      ...providerCleanup.envVarAliases,
    ]),
  ];

  const persistedEnvVarNames = new Set(
    await getPersistedEnvironmentVariableNames(),
  );
  if (!envVarNames.some((name) => persistedEnvVarNames.has(name))) {
    return { success: true as const, provider, warnings: [] };
  }

  const [providerRepositories, state] = await Promise.all([
    db.query.repositories.findMany({
      where: eq(repositories.sourceControlProvider, provider),
      columns: {
        id: true,
        externalRepoId: true,
        fullName: true,
        permissions: true,
      },
    }),
    providerCleanup.loadState?.() ?? Promise.resolve({}),
  ]);

  await providerCleanup.disconnect?.(auth);

  const warnings: ClearSourceControlConfigWarning[] = [];
  if (provider !== 'github') {
    warnings.push(
      ...(await removeProviderHooks(
        provider,
        providerCleanup,
        providerRepositories,
      )),
    );
  }
  warnings.push(...(await removeProviderOAuthConnection(providerCleanup)));

  const now = new Date();
  await db.transaction(async (tx) => {
    await deleteDeploymentEnvironmentVariables(tx, envVarNames);
    await tx
      .update(repositories)
      .set({ isActive: false, updatedAt: now })
      .where(eq(repositories.sourceControlProvider, provider));
    await providerCleanup.clearLocalState?.(tx, state);
  });

  return { success: true as const, provider, warnings };
}
