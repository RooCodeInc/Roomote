'use client';

import { useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { ReasoningEffort } from '@roomote/types';
import { stagePendingFastSessionLaunch } from '@/lib/pending-fast-session-launch';
import { sessionPathWithVoiceAutostart } from '@/lib/voice-autostart';
import { describeValidationError } from '@/lib/validation-error';

import { useStartFastSession } from './useStartFastSession';

type FastSessionSubmission = {
  text: string;
  images?: string[];
  attachmentTexts?: string[];
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  /** Open the Session for a voice call; it may start with nothing typed. */
  voiceCall?: boolean;
};

export function useFastSessionLauncher(options?: {
  onSessionStarted?: () => void;
}) {
  const onSessionStarted = options?.onSessionStarted;
  const router = useRouter();
  const mutation = useStartFastSession();
  const retryRef = useRef<{
    conversationId: string;
    payloadKey: string;
  } | null>(null);

  const startFastSession = useCallback(
    async (
      payload: FastSessionSubmission,
      launchOptions: { voice?: boolean } = {},
    ): Promise<void> => {
      // A second submit while the first is in flight would mint a second
      // Session and orphan one of them.
      if (mutation.isPending) return;

      const payloadKey = JSON.stringify(payload);
      const conversationId =
        retryRef.current?.payloadKey === payloadKey
          ? retryRef.current.conversationId
          : crypto.randomUUID();
      retryRef.current = { conversationId, payloadKey };

      try {
        const { sessionId, fastConversationId } = await mutation.mutateAsync({
          ...payload,
          conversationId,
        });
        if (
          payload.text ||
          payload.images?.length ||
          payload.attachmentTexts?.length
        ) {
          stagePendingFastSessionLaunch(sessionId, {
            fastConversationId: fastConversationId ?? conversationId,
            presenceClientId: conversationId,
            text: payload.text,
            images: payload.images,
          });
        }
        retryRef.current = null;
        onSessionStarted?.();
        router.push(
          launchOptions.voice
            ? sessionPathWithVoiceAutostart(sessionId)
            : `/sessions/${sessionId}`,
        );
      } catch (error) {
        toast.error(describeValidationError(error, 'Failed to start session'));
      }
    },
    [mutation, onSessionStarted, router],
  );

  return {
    isPending: mutation.isPending,
    mutation,
    startFastSession,
  };
}
