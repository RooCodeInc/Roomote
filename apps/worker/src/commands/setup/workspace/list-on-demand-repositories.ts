import { sdk } from '@roomote/sdk/client';
import {
  DEFAULT_SOURCE_CONTROL_PROVIDER,
  type SourceControlProvider,
} from '@roomote/types';

import type { OnDemandRepository } from '../../../workspace/on-demand-repositories';

type ListedRepository = Awaited<
  ReturnType<typeof sdk.repositories.listRepositories>
>[number];

function toOnDemandRepository(
  repository: Pick<ListedRepository, 'fullName'> &
    Partial<
      Pick<
        ListedRepository,
        'sourceControlProvider' | 'defaultBranch' | 'description' | 'private'
      >
    >,
  sourceControlProvider: SourceControlProvider,
): OnDemandRepository {
  return {
    fullName: repository.fullName,
    sourceControlProvider,
    defaultBranch: repository.defaultBranch || 'main',
    description: repository.description ?? null,
    private: repository.private ?? false,
  };
}

/**
 * Resolve the repositories an all-repositories workspace exposes for
 * on-demand checkout. A stamped provider map is the launch-time workspace
 * snapshot, so when it is present the live list is narrowed to it and each
 * entry keeps its stamped provider; otherwise the deployment's active
 * repositories for the run's source-control provider are used.
 *
 * The manifest keeps every stamped entry, because a repository prepared at
 * setup stays on disk even if it is deactivated later. `checkoutableOnly`
 * instead drops stamped entries that are no longer active under their stamped
 * provider, which is exactly what `clone_repository` would reject.
 */
export async function listOnDemandRepositories(
  {
    sourceControlProvider = DEFAULT_SOURCE_CONTROL_PROVIDER,
    repositoryProviders,
  }: {
    sourceControlProvider?: SourceControlProvider;
    repositoryProviders?: Record<string, SourceControlProvider>;
  },
  { checkoutableOnly = false }: { checkoutableOnly?: boolean } = {},
): Promise<OnDemandRepository[]> {
  const stampedProviders = Object.entries(repositoryProviders ?? {});

  if (stampedProviders.length === 0) {
    const repositories = await sdk.repositories.listRepositories({
      sourceControlProvider,
    });

    return repositories.map((repository) =>
      toOnDemandRepository(
        repository,
        repository.sourceControlProvider ?? sourceControlProvider,
      ),
    );
  }

  const active = await sdk.repositories.listRepositories({});

  if (checkoutableOnly) {
    return stampedProviders.flatMap(([fullName, provider]) => {
      const repository = active.find(
        (candidate) =>
          candidate.fullName === fullName &&
          (candidate.sourceControlProvider ??
            DEFAULT_SOURCE_CONTROL_PROVIDER) === provider,
      );

      return repository ? [toOnDemandRepository(repository, provider)] : [];
    });
  }

  const listed = new Map(
    active.map((repository) => [repository.fullName, repository]),
  );

  return stampedProviders.map(([fullName, provider]) =>
    toOnDemandRepository(listed.get(fullName) ?? { fullName }, provider),
  );
}
