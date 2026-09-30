'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getSessionStatusLabel,
  type SessionManualStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { announceSessionBoardMove } from './session-board-motion';

export function useSessionStatusMutation() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.sessions.setStatus.mutationOptions({
      onSuccess: (result, variables) => {
        if (!result) {
          toast.error('Failed to update session status.');
          return;
        }

        const { sessionId, status } = variables as {
          sessionId: string;
          status: SessionManualStatus;
        };
        announceSessionBoardMove(sessionId, status);
        toast.success(`Session marked as ${getSessionStatusLabel(status)}.`);
        void queryClient.invalidateQueries({
          queryKey: trpc.sessions.byId.queryKey({ sessionId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.sessions.list.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.sessions.search.queryKey(),
        });
        router.refresh();
      },
      onError: (error) =>
        toast.error(error.message || 'Failed to update session status.'),
    }),
  );
}
