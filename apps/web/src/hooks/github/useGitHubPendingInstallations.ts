'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useGitHubPendingInstallations = (options?: {
  enabled?: boolean;
  refetchInterval?: number;
}) => {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.github.pendingInstallations.queryOptions(),
    ...options,
  });
};
