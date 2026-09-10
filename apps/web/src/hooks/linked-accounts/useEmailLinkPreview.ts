import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export const useEmailLinkPreview = (token: string | null) => {
  const trpc = useTRPC();

  return useQuery(
    trpc.linkedAccounts.previewEmailLink.queryOptions(
      { token: token ?? '' },
      { enabled: Boolean(token), retry: false },
    ),
  );
};
