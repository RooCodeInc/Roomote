'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useLinearOauthSetup(enabled = true) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.linear.oauthSetup.queryOptions(),
    enabled,
  });
}
