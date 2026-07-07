import { useQuery } from '@tanstack/react-query';
import type { SourceControlProvider } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

type UseRepositoriesInput = {
  includeEmptyState?: boolean;
  sourceControlProvider?: SourceControlProvider;
};

export const useRepositories = (input?: UseRepositoriesInput) => {
  const trpc = useTRPC();

  return useQuery(trpc.sourceControl.repositories.queryOptions(input));
};
