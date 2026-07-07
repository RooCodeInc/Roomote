'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useGitHubInstallations = () => {
  const trpc = useTRPC();

  return useQuery(trpc.github.installations.queryOptions());
};
