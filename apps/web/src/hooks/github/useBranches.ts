import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useBranches = (fullName?: string) => {
  const trpc = useTRPC();

  return useQuery(
    trpc.github.branches.queryOptions(
      { fullName: fullName! },
      { enabled: !!fullName },
    ),
  );
};
