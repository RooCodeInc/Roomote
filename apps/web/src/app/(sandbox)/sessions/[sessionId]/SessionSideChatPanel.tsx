'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { FramedSurface } from '@/components/layout';
import { Loader2Icon } from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { SandboxSidePanelHeader } from '../../SandboxSidePanelHeader';
import { FastSessionTranscript } from './FastSessionTranscript';

export function SessionSideChatPanel({
  parentSessionId,
  onClose,
}: {
  parentSessionId: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const startedRef = useRef(false);
  const sideChat = useMutation(
    trpc.sessions.sideChat.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );
  const [detail, setDetail] = useState<typeof sideChat.data>();

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void sideChat
      .mutateAsync({ sessionId: parentSessionId })
      .then(setDetail)
      .catch(() => undefined);
  }, [parentSessionId, sideChat]);

  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      <SandboxSidePanelHeader
        title="Side chat"
        onClose={onClose}
        closeLabel="Close side chat"
      />
      {detail === undefined && !sideChat.isError ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          aria-label="Opening side chat"
        >
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : detail ? (
        <FastSessionTranscript
          sessionId={detail.fastConversationId}
          initialMessages={detail.messages}
          hasOlderMessages={detail.hasOlderMessages}
          canReply
          initialTitle={detail.title}
          fallbackTitle="Side chat"
          sessionModel={detail.model}
          sessionReasoningEffort={detail.reasoningEffort}
          showHeader={false}
          updatePageTitle={false}
          allowVoice={false}
          showInitialThinking={false}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Side chat is unavailable for this session.
        </div>
      )}
    </FramedSurface>
  );
}
