import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/trpc/client';

export function useExecuteRevertCommit() {
  const trpc = useTRPC();

  return useMutation(trpc.github.executeRevertCommit.mutationOptions());
}
