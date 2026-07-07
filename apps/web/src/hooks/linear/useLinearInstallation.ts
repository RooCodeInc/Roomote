import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useLinearInstallation = (options?: { enabled?: boolean }) => {
  const trpc = useTRPC();

  return useQuery(
    trpc.linear.installation.queryOptions(undefined, {
      enabled: options?.enabled ?? true,
    }),
  );
};
