import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TaskResolutionStatus } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

export function isTaskResolutionActionable(
  resolutionStatus: TaskResolutionStatus | null | undefined,
): boolean {
  return (
    resolutionStatus === 'awaiting_confirmation' ||
    resolutionStatus === 'needs_follow_up'
  );
}

export function useAcknowledgeTaskResolution() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.tasks.acknowledgeResolution.mutationOptions({
      onSuccess: (_data, { taskId }) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.tasks.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.tasks.byId.queryKey({ taskId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.tasks.byId.queryKey({
            taskId,
            includeArtifacts: true,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.tasks.byId.queryKey({
            taskId,
            includeArtifacts: false,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.sandboxSession.byTaskId.queryKey({ taskId }),
        });
      },
    }),
  );
}
