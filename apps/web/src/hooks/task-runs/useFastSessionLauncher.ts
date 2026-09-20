'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { ReasoningEffort } from '@roomote/types';
import { stagePendingFastSessionLaunch } from '@/lib/pending-fast-session-launch';
import { sessionPathWithVoiceAutostart } from '@/lib/voice-autostart';

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
  showErrorToast?: boolean;
}) {
  const onSessionStarted = options?.onSessionStarted;
  const showErrorToast = options?.showErrorToast ?? true;
  const router = useRouter();
  const mutation = useStartFastSession();
  const [error, setError] = useState<Error | null>(null);
  const inFlightRef = useRef(false);
  const retryRef = useRef<{
    conversationId: string;
    payloadKey: string;
  } | null>(null);
  const failedLaunchRef = useRef<{
    payload: FastSessionSubmission;
    launchOptions: { voice?: boolean };
  } | null>(null);

  const startFastSession = useCallback(
    async (
      payload: FastSessionSubmission,
      launchOptions: { voice?: boolean } = {},
    ): Promise<void> => {
      // A second submit while the first is in flight would mint a second
      // Session and orphan one of them.
      if (inFlightRef.current || mutation.isPending) return;
      inFlightRef.current = true;
      setError(null);

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
        failedLaunchRef.current = null;
        onSessionStarted?.();
        router.push(
          launchOptions.voice
            ? sessionPathWithVoiceAutostart(sessionId)
            : `/sessions/${sessionId}`,
        );
      } catch (error) {
        const startError =
          error instanceof Error ? error : new Error('Failed to start session');
        failedLaunchRef.current = { payload, launchOptions };
        setError(startError);
        if (showErrorToast) toast.error(startError.message);
      } finally {
        inFlightRef.current = false;
      }
    },
    [mutation, onSessionStarted, router, showErrorToast],
  );

  const retryFastSession = useCallback(async (): Promise<void> => {
    const failedLaunch = failedLaunchRef.current;
    if (!failedLaunch) return;
    await startFastSession(failedLaunch.payload, failedLaunch.launchOptions);
  }, [startFastSession]);

  return {
    error,
    isPending: mutation.isPending,
    mutation,
    retryFastSession,
    startFastSession,
  };
}
