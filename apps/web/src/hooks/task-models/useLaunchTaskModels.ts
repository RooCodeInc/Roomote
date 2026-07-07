import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useLaunchTaskModels() {
  const trpc = useTRPC();

  return useQuery(trpc.taskModels.launchOptions.queryOptions());
}
