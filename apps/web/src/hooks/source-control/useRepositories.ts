import { useQuery } from '@tanstack/react-query';
import type { SourceControlProvider } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

type UseRepositoriesInput = {
  includeEmptyState?: boolean;
  sourceControlProvider?: SourceControlProvider;
};

type UseRepositoriesOptions = {
  refetchInterval?: number | false;
  refetchIntervalInBackground?: false;
};

export const useRepositories = (
  input?: UseRepositoriesInput,
  options?: UseRepositoriesOptions,
) => {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.sourceControl.repositories.queryOptions(input),
    ...options,
  });
};
