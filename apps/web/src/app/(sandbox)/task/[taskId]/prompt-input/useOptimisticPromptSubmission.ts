'use client';

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { TaskMessageEnvelope } from '@/types';
import { useTRPC } from '@/trpc/client';

import {
  useSandboxAppendOptimisticAcpEvent,
  useSandboxAppendOptimisticQueuedMessage,
  useSandboxCurrentUserInfo,
  useSandboxRemoveOptimisticMessage,
  useSandboxRemoveOptimisticQueuedMessage,
} from '../hooks/SandboxProvider';
import {
  appendOptimisticPromptEnvelope,
  removeOptimisticPromptEnvelope,
} from '../hooks/services/optimistic-prompt-envelope-state';

import { createOptimisticPromptArtifacts } from './optimistic-prompt';

type OptimisticPromptLocation = 'transcript' | 'queue';

type StartOptimisticPromptSubmissionInput = {
  taskId: string;
  prompt: string;
  images?: string[];
  location: OptimisticPromptLocation;
};

type RollbackOptimisticPromptSubmissionInput = {
  taskId: string;
  clientMessageId: string;
  location: OptimisticPromptLocation;
};

export function useOptimisticPromptSubmission() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const appendOptimisticAcpEvent = useSandboxAppendOptimisticAcpEvent();
  const appendOptimisticQueuedMessage =
    useSandboxAppendOptimisticQueuedMessage();
  const removeOptimisticMessage = useSandboxRemoveOptimisticMessage();
  const removeOptimisticQueuedMessage =
    useSandboxRemoveOptimisticQueuedMessage();
  const currentUserInfo = useSandboxCurrentUserInfo();

  const updateTranscriptEnvelopes = useCallback(
    (
      taskId: string,
      updater: (
        current: TaskMessageEnvelope[] | undefined,
      ) => TaskMessageEnvelope[] | undefined,
    ) => {
      queryClient.setQueryData<TaskMessageEnvelope[] | undefined>(
        trpc.tasks.messageEnvelopes.queryKey({ taskId }),
        updater,
      );
    },
    [queryClient, trpc],
  );

  const startOptimisticPromptSubmission = useCallback(
    ({
      taskId,
      prompt,
      images,
      location,
    }: StartOptimisticPromptSubmissionInput) => {
      const clientMessageId = globalThis.crypto.randomUUID();
      const optimisticPrompt = createOptimisticPromptArtifacts({
        taskId,
        prompt,
        images,
        clientMessageId,
        currentUserInfo,
      });

      if (location === 'transcript') {
        appendOptimisticAcpEvent(optimisticPrompt.event);
        updateTranscriptEnvelopes(taskId, (current) =>
          appendOptimisticPromptEnvelope(current, optimisticPrompt.envelope),
        );
      } else {
        appendOptimisticQueuedMessage(optimisticPrompt.queuedMessage);
      }

      return { clientMessageId };
    },
    [
      appendOptimisticAcpEvent,
      appendOptimisticQueuedMessage,
      currentUserInfo,
      updateTranscriptEnvelopes,
    ],
  );

  const rollbackOptimisticPromptSubmission = useCallback(
    ({
      taskId,
      clientMessageId,
      location,
    }: RollbackOptimisticPromptSubmissionInput) => {
      if (location === 'transcript') {
        removeOptimisticMessage(clientMessageId);
        updateTranscriptEnvelopes(taskId, (current) =>
          removeOptimisticPromptEnvelope(current, clientMessageId),
        );
        return;
      }

      removeOptimisticQueuedMessage(clientMessageId);
    },
    [
      removeOptimisticMessage,
      removeOptimisticQueuedMessage,
      updateTranscriptEnvelopes,
    ],
  );

  return {
    rollbackOptimisticPromptSubmission,
    startOptimisticPromptSubmission,
  };
}
