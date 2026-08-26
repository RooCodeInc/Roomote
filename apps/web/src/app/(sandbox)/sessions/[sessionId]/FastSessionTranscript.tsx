'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  getImageUrisFromContentBlocks,
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
import { WorkspaceHeader } from '@/components/layout';
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

function getUserMessageIdentity(message: TranscriptMessage) {
  return JSON.stringify([
    getTextFromContentBlocks(message.contentBlocks)?.trim() ?? '',
    getImageUrisFromContentBlocks(message.contentBlocks),
  ]);
}

export function FastSessionTranscript({
  sessionId,
  initialMessages,
  hasOlderMessages,
  canReply,
  initialTitle = null,
  fallbackTitle = 'Session',
  sessionModel = null,
  sessionReasoningEffort = null,
  defaultModelId = null,
  defaultReasoningEffort = null,
  headerExtras,
  timelineExtras,
}: {
  sessionId: string;
  initialMessages: FastSessionMessage[];
  hasOlderMessages?: boolean;
  canReply?: boolean;
  initialTitle?: string | null;
  fallbackTitle?: string;
  sessionModel?: string | null;
  sessionReasoningEffort?: ReasoningEffort | null;
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  headerExtras?: ReactNode;
  timelineExtras?: ReactNode;
}) {
  const trpcClient = useTRPCClient();
  const [serverMessages, setServerMessages] = useState<
    Map<string, TranscriptMessage>
  >(
    () => new Map(initialMessages.map((message) => [message.eventId, message])),
  );
  const serverMessagesRef = useRef(serverMessages);
  const [optimisticMessages, setOptimisticMessages] = useState<
    TranscriptMessage[]
  >([]);
  const [isSending, setIsSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(initialTitle);

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${sessionId}/stream`);
    const onMessages = (event: MessageEvent) => {
      try {
        const { messages } = JSON.parse(event.data) as {
          messages: TranscriptMessage[];
        };
        const previous = serverMessagesRef.current;
        const canonicalUserMessages = messages.filter(
          (message) =>
            message.role === 'user' && !previous.has(message.eventId),
        );
        const next = new Map(previous);
        for (const message of messages) {
          next.set(message.eventId, message);
        }
        serverMessagesRef.current = next;
        setServerMessages(next);

        if (canonicalUserMessages.length > 0) {
          setOptimisticMessages((current) => {
            const pending = [...current];
            for (const canonical of canonicalUserMessages) {
              const index = pending.findIndex(
                (optimistic) =>
                  getUserMessageIdentity(optimistic) ===
                  getUserMessageIdentity(canonical),
              );
              if (index >= 0) pending.splice(index, 1);
            }
            return pending;
          });
        }
      } catch {
        // Ignore malformed frames; the next poll re-sends current state.
      }
    };
    const onSession = (event: MessageEvent) => {
      try {
        const { title: nextTitle } = JSON.parse(event.data) as {
          title: string | null;
        };
        setTitle(nextTitle);
      } catch {
        // Ignore malformed frames.
      }
    };
    source.addEventListener('messages', onMessages);
    source.addEventListener('session', onSession);
    return () => {
      source.removeEventListener('messages', onMessages);
      source.removeEventListener('session', onSession);
      source.close();
    };
  }, [sessionId]);

  const messages = useMemo(() => {
    return [...serverMessages.values(), ...optimisticMessages].sort(
      compareTranscriptMessages,
    );
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
    async (message: SessionPromptSubmission): Promise<boolean> => {
      if (isSending) {
        return false;
      }

      setIsSending(true);
      setReplyError(null);
      let optimisticId: string | null = null;
      try {
        const prepared = await preparePromptAttachments({
          text: message.text.trim(),
          attachments: message.files,
        });
        const images = prepared.images ?? [];
        if (!prepared.text && images.length === 0) {
          return false;
        }

        optimisticId = `optimistic:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const imageBlocks: TranscriptMessage['contentBlocks'] = images.flatMap(
          (image) => {
            const match = /^data:(image\/[^;,]+);base64,(.+)$/i.exec(
              image.trim(),
            );
            return match?.[1] && match[2]
              ? [{ type: 'image', mimeType: match[1], data: match[2] }]
              : [];
          },
        );
        const optimistic: TranscriptMessage = {
          id: optimisticId,
          eventId: optimisticId,
          turnId: 'optimistic',
          turnSeq: 0,
          ts: Date.now(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          contentBlocks: [
            { type: 'text', text: prepared.text },
            ...imageBlocks,
          ],
          metadata: { visibleInTranscript: true },
          payload: {},
          source: 'web',
          nativeSessionId: null,
          nativeMessageId: null,
          createdAt: new Date(),
        };
        setOptimisticMessages((previous) => [...previous, optimistic]);
        await trpcClient.fastSessions.reply.mutate({
          sessionId,
          text: prepared.text,
          ...(images.length > 0 ? { images } : {}),
          model: message.model ?? null,
          reasoningEffort: message.reasoningEffort ?? null,
        });
        return true;
      } catch (error) {
        if (optimisticId) {
          const failedId = optimisticId;
          setOptimisticMessages((previous) =>
            previous.filter((row) => row.eventId !== failedId),
          );
        }
        setReplyError(
          error instanceof Error ? error.message : 'Failed to send message',
        );
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [isSending, sessionId, trpcClient],
  );

  return (
    <MessageUiOptionsProvider>
      <WorkspaceHeader contentClassName="flex-row items-center gap-3">
        <h1 className="ph-no-capture min-w-0 flex-1 truncate text-sm font-medium">
          {title ?? fallbackTitle}
        </h1>
        {headerExtras}
      </WorkspaceHeader>
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="ph-no-capture mx-auto w-full max-w-4xl p-4">
          {hasOlderMessages ? (
            <p className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
              Older messages in this session are not shown.
            </p>
          ) : null}
          {timelineExtras}
          <AcpTranscriptBlockList
            blocks={renderBlocks}
            showInternalMessages={false}
            onSuppress={suppressMessage}
          />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {canReply ? (
        <div className="mx-auto w-full shrink-0 overflow-clip rounded-t-md rounded-b-3xl border-2 border-background bg-card transition-colors @[56rem]:rounded-t-lg">
          <SessionPromptInput
            isBusy={isSending}
            onSend={sendReply}
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
