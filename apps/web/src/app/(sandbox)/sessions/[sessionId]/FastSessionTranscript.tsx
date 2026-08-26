'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  getTextFromContentBlocks,
  inferAcpMessageKind,
  type AcpEventType,
  type ReasoningEffort,
} from '@roomote/types';

import type { FastSessionMessage } from '@/lib/server/fast-sessions';
import { useTRPCClient } from '@/trpc/client';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  MessageUiOptionsProvider,
} from '@/components/ai-elements';
import { BotMessageSquare, EmptyState } from '@/components/system';
import {
  SessionPromptInput,
  type SessionPromptSubmission,
} from './SessionPromptInput';
import { preparePromptAttachments } from '@/lib/prompt-attachments';

import {
  AcpTranscriptBlockList,
  useAcpTranscriptBlocks,
} from '../../task/[taskId]/messages/acp';
import { toAcpUiMessage } from '../../task/[taskId]/hooks/services/acp-protocol-service';

/** Rows arriving over the SSE stream have `createdAt` serialized to a string;
 * the transcript only sorts on ts/turnSeq/id, so both shapes are accepted. */
type TranscriptMessage = Omit<FastSessionMessage, 'createdAt'> & {
  createdAt: Date | string;
};

function compareTranscriptMessages(a: TranscriptMessage, b: TranscriptMessage) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.turnSeq !== b.turnSeq) return a.turnSeq - b.turnSeq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function FastSessionTranscript({
  sessionId,
  initialMessages,
  hasOlderMessages,
  canReply,
  sessionModel = null,
  sessionReasoningEffort = null,
  defaultModelId = null,
  defaultReasoningEffort = null,
}: {
  sessionId: string;
  initialMessages: FastSessionMessage[];
  hasOlderMessages?: boolean;
  canReply?: boolean;
  sessionModel?: string | null;
  sessionReasoningEffort?: ReasoningEffort | null;
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
}) {
  const trpcClient = useTRPCClient();
  const [serverMessages, setServerMessages] = useState<
    Map<string, TranscriptMessage>
  >(
    () => new Map(initialMessages.map((message) => [message.eventId, message])),
  );
  const [optimisticMessages, setOptimisticMessages] = useState<
    TranscriptMessage[]
  >([]);
  const [isSending, setIsSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${sessionId}/stream`);
    const onMessages = (event: MessageEvent) => {
      try {
        const { messages } = JSON.parse(event.data) as {
          messages: TranscriptMessage[];
        };
        setServerMessages((previous) => {
          const next = new Map(previous);
          for (const message of messages) {
            next.set(message.eventId, message);
          }
          return next;
        });
      } catch {
        // Ignore malformed frames; the next poll re-sends current state.
      }
    };
    source.addEventListener('messages', onMessages);
    return () => {
      source.removeEventListener('messages', onMessages);
      source.close();
    };
  }, [sessionId]);

  const messages = useMemo(() => {
    const serverList = [...serverMessages.values()];
    const serverUserTexts = new Set(
      serverList
        .filter((message) => message.role === 'user')
        .map((message) =>
          getTextFromContentBlocks(message.contentBlocks)?.trim(),
        )
        .filter(Boolean),
    );
    const pending = optimisticMessages.filter(
      (message) =>
        !serverUserTexts.has(
          getTextFromContentBlocks(message.contentBlocks)?.trim(),
        ),
    );
    return [...serverList, ...pending].sort(compareTranscriptMessages);
  }, [serverMessages, optimisticMessages]);

  const uiMessages = useMemo(
    () =>
      messages.map((message) =>
        toAcpUiMessage({
          id: message.id,
          ts: message.ts,
          eventType: message.eventType as AcpEventType,
          role: message.role,
          kind: inferAcpMessageKind(message.eventType),
          contentBlocks: message.contentBlocks,
          metadata: message.metadata,
          payload: message.payload,
          text: getTextFromContentBlocks(message.contentBlocks) ?? undefined,
        }),
      ),
    [messages],
  );
  const { renderBlocks, suppressMessage } = useAcpTranscriptBlocks({
    messages: uiMessages,
    artifacts: [],
    displayMode: 'default',
    initialPrompt: null,
    shouldHideFirstMessage: false,
    showInternalMessages: false,
    hasLeadingTextBoundary: false,
    resetKey: `${messages.length}:${messages[0]?.eventId ?? ''}:${messages.at(-1)?.eventId ?? ''}`,
  });

  const sendReply = useCallback(
    async (message: SessionPromptSubmission) => {
      if (isSending) {
        return;
      }

      const prepared = await preparePromptAttachments({
        text: message.text.trim(),
        attachments: message.files,
      });
      const images = prepared.images ?? [];
      if (!prepared.text && images.length === 0) {
        return;
      }

      setIsSending(true);
      setReplyError(null);
      const optimisticId = `optimistic:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const optimistic: TranscriptMessage = {
        id: optimisticId,
        eventId: optimisticId,
        turnId: 'optimistic',
        turnSeq: 0,
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: [{ type: 'text', text: prepared.text }],
        metadata: { visibleInTranscript: true },
        payload: {},
        source: 'web',
        nativeSessionId: null,
        nativeMessageId: null,
        createdAt: new Date(),
      };

      try {
        setOptimisticMessages((previous) => [...previous, optimistic]);
        await trpcClient.fastSessions.reply.mutate({
          sessionId,
          text: prepared.text,
          ...(images.length > 0 ? { images } : {}),
          model: message.model ?? null,
          reasoningEffort: message.reasoningEffort ?? null,
        });
      } catch (error) {
        setOptimisticMessages((previous) =>
          previous.filter((row) => row.eventId !== optimistic.eventId),
        );
        setReplyError(
          error instanceof Error ? error.message : 'Failed to send message',
        );
      } finally {
        setIsSending(false);
      }
    },
    [isSending, sessionId, trpcClient],
  );

  return (
    <MessageUiOptionsProvider>
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="ph-no-capture mx-auto w-full max-w-4xl p-4">
          {hasOlderMessages ? (
            <p className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
              Older messages in this session are not shown.
            </p>
          ) : null}
          <AcpTranscriptBlockList
            blocks={renderBlocks}
            showInternalMessages={false}
            onSuppress={suppressMessage}
          />
          {messages.length === 0 ? (
            <EmptyState
              icon={<BotMessageSquare className="size-6" />}
              title="No canonical messages"
              description="This session predates canonical Fast message persistence or has not recorded a new turn yet."
              containerClassName="py-10"
            />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {canReply ? (
        <div className="mx-auto w-full shrink-0 overflow-clip rounded-t-md rounded-b-3xl border-2 border-background bg-card transition-colors @[56rem]:rounded-t-lg">
          <SessionPromptInput
            isBusy={isSending}
            onSend={(submission) => void sendReply(submission)}
            initialModel={sessionModel}
            initialReasoningEffort={sessionReasoningEffort}
            defaultModelId={defaultModelId}
            defaultReasoningEffort={defaultReasoningEffort}
          />
          {replyError ? (
            <p className="px-4 pb-2 text-xs text-destructive">{replyError}</p>
          ) : null}
        </div>
      ) : null}
    </MessageUiOptionsProvider>
  );
}
