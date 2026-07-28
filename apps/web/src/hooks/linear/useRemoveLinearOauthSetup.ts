'use client';

import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

import { useInvalidateLinearOauthSetup } from './useInvalidateLinearOauthSetup';

export function useRemoveLinearOauthSetup() {
  const trpc = useTRPC();
  const invalidateLinearOauthSetup = useInvalidateLinearOauthSetup();

  return useMutation(
    trpc.linear.removeOauthSetup.mutationOptions({
      onSuccess: invalidateLinearOauthSetup,
    }),
  );
}
