'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  getTextFromContentBlocks,
  inferAcpMessageKind,
  type AcpEventType,
} from '@roomote/types';

import type { FastSessionMessage } from '@/lib/server/fast-sessions';
import { useTRPCClient } from '@/trpc/client';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  MessageUiOptionsProvider,
} from '@/components/ai-elements';
import {
  BotMessageSquare,
  Button,
  EmptyState,
  SendHorizontal,
  Textarea,
} from '@/components/system';

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
}: {
  sessionId: string;
  initialMessages: FastSessionMessage[];
  hasOlderMessages?: boolean;
  canReply?: boolean;
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
  const [draft, setDraft] = useState('');
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

  const sendReply = useCallback(async () => {
    const text = draft.trim();
    if (!text || isSending) {
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
      contentBlocks: [{ type: 'text', text }],
      metadata: { visibleInTranscript: true },
      payload: {},
      source: 'web',
      nativeSessionId: null,
      nativeMessageId: null,
      createdAt: new Date(),
    };

    try {
      setOptimisticMessages((previous) => [...previous, optimistic]);
      setDraft('');
      await trpcClient.fastSessions.reply.mutate({ sessionId, text });
    } catch (error) {
      setOptimisticMessages((previous) =>
        previous.filter((message) => message.eventId !== optimistic.eventId),
      );
      setDraft(text);
      setReplyError(
        error instanceof Error ? error.message : 'Failed to send message',
      );
    } finally {
      setIsSending(false);
    }
  }, [draft, isSending, sessionId, trpcClient]);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void sendReply();
    },
    [sendReply],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        <form
          onSubmit={handleSubmit}
          className="mx-auto w-full max-w-4xl shrink-0 px-4 pb-4"
        >
          <div className="flex items-end gap-2 rounded-lg border border-border bg-background p-2">
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendReply();
                }
              }}
              placeholder="Reply to Fast…"
              className="ph-no-capture max-h-40 min-h-10 flex-1 resize-none border-0 shadow-none focus-visible:ring-0"
              disabled={isSending}
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send reply"
              disabled={isSending || !draft.trim()}
            >
              <SendHorizontal />
            </Button>
          </div>
          {replyError ? (
            <p className="mt-1 text-xs text-destructive">{replyError}</p>
          ) : null}
        </form>
      ) : null}
    </MessageUiOptionsProvider>
  );
}
