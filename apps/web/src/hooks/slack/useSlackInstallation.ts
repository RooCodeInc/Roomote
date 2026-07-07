import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useSlackInstallation = (options?: { enabled?: boolean }) => {
  const trpc = useTRPC();

  return useQuery(
    trpc.slack.installation.queryOptions(undefined, {
      enabled: options?.enabled ?? true,
    }),
  );
};
