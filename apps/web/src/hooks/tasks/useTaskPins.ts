import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

const PIN_LIMIT_MESSAGE = 'You can pin up to 5 tasks.';
type PinnedTask = { taskId: string; updatedAt: Date };

export function useTaskPins() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const pinsQueryKey = trpc.tasks.pins.queryKey();

  const { data: pinnedTasks = [] } = useQuery(trpc.tasks.pins.queryOptions());

  const pinnedTaskIds = useMemo(
    () => pinnedTasks.map((pin) => pin.taskId),
    [pinnedTasks],
  );

  const setTaskPinnedMutation = useMutation(
    trpc.tasks.setPinned.mutationOptions({
      onMutate: async (variables) => {
        await queryClient.cancelQueries({ queryKey: pinsQueryKey });

        const previousPinnedTasks =
          queryClient.getQueryData<PinnedTask[]>(pinsQueryKey) ?? [];

        queryClient.setQueryData<PinnedTask[]>(pinsQueryKey, (current = []) => {
          const withoutTask = current.filter(
            (pin) => pin.taskId !== variables.taskId,
          );

          if (!variables.pinned) {
            return withoutTask;
          }

          return [
            {
              taskId: variables.taskId,
              updatedAt: new Date(),
            },
            ...withoutTask,
          ];
        });

        return { previousPinnedTasks };
      },
      onSuccess: (result, _variables, context) => {
        if (!result.success) {
          queryClient.setQueryData(
            pinsQueryKey,
            context?.previousPinnedTasks ?? [],
          );

          if (result.error === 'pin_limit_reached') {
            toast.error(PIN_LIMIT_MESSAGE);
            return;
          }

          toast.error('Task is unavailable for pinning.');
          return;
        }
      },
      onError: (_error, _variables, context) => {
        queryClient.setQueryData(
          pinsQueryKey,
          context?.previousPinnedTasks ?? [],
        );
        toast.error('Failed to update task pin.');
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: pinsQueryKey });
      },
    }),
  );

  const setTaskPinned = useCallback(
    (taskId: string, pinned: boolean) => {
      setTaskPinnedMutation.mutate({ taskId, pinned });
    },
    [setTaskPinnedMutation],
  );

  const isTaskPinMutationPending = useCallback(
    (taskId: string) =>
      setTaskPinnedMutation.isPending &&
      setTaskPinnedMutation.variables?.taskId === taskId,
    [setTaskPinnedMutation.isPending, setTaskPinnedMutation.variables],
  );

  return {
    pinnedTasks,
    pinnedTaskIds,
    setTaskPinned,
    isTaskPinMutationPending,
  };
}
