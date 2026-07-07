'use client';

import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';
import { useSandboxPendingEnvVarRequest } from './SandboxProvider';

export function useTaskEnvVarRequest(_taskId: string) {
  return useSandboxPendingEnvVarRequest();
}

export function useFulfillTaskEnvVarRequest(_taskId: string) {
  const trpc = useTRPC();

  return useMutation(trpc.taskEnvVarRequests.fulfill.mutationOptions());
}
