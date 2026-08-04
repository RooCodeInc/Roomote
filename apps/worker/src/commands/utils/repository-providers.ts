import type { SourceControlProvider } from '@roomote/types';

export function resolveRepositoryProvidersFromPayload(
  payload: unknown,
): Record<string, SourceControlProvider> | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  return (
    payload as {
      repositoryProviders?: Record<string, SourceControlProvider>;
    }
  ).repositoryProviders;
}
