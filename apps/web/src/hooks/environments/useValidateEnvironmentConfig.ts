'use client';

import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useValidateEnvironmentConfig() {
  const trpc = useTRPC();

  return useMutation(trpc.environments.validateConfig.mutationOptions());
}
