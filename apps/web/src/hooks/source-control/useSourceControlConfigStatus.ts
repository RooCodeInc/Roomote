import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useSourceControlConfigStatus = () => {
  const trpc = useTRPC();

  return useQuery(trpc.sourceControl.configStatus.queryOptions(undefined));
};
