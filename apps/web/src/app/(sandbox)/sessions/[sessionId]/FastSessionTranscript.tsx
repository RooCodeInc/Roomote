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
  parsePrReviewActionOffer,
  type PrReviewActionChoice,
  type AcpEventType,
  type ReasoningEffort,
} from '@roomote/types';

import type { FastSessionMessage } from '@/lib/server/fast-sessions';
import { useTRPCClient } from '@/trpc/client';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Message,
  MessageContent,
  MessageUiOptionsProvider,
  Shimmer,
} from '@/components/ai-elements';
import { WorkspaceHeader } from '@/components/layout';
import {
  SessionPromptInput,
  type SessionPromptSubmission,
} from './SessionPromptInput';
import { preparePromptAttachments } from '@/lib/prompt-attachments';
import { useOpenSessionTaskPanel } from './session-task-panel-context';
import { useNarrationMode } from '@/hooks/useNarrationMode';
import { usePageTitle } from '@/hooks/usePageTitle';
import { truncatePageTitle } from '@/lib/page-title';
import { PrReviewActionOffer } from '@/components/ai-elements/pr-review-action-offer';

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

type TranscriptOrder = Pick<TranscriptMessage, 'id' | 'ts' | 'turnSeq'>;

function compareTranscriptOrder(a: TranscriptOrder, b: TranscriptOrder) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.turnSeq !== b.turnSeq) return a.turnSeq - b.turnSeq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareTranscriptMessages(a: TranscriptMessage, b: TranscriptMessage) {
  return compareTranscriptOrder(a, b);
}

function getUserMessageIdentity(message: TranscriptMessage) {
  return JSON.stringify([
    getTextFromContentBlocks(message.contentBlocks)?.trim() ?? '',
    getImageUrisFromContentBlocks(message.contentBlocks),
  ]);
}

function isVisibleResponseActivity(message: TranscriptMessage) {
  return (
    message.role !== 'user' && message.metadata?.visibleInTranscript !== false
  );
}

function getPendingResponseOrder(messages: TranscriptMessage[]) {
  let pendingAfter: TranscriptOrder | null =
    messages.length === 0 ? { id: '', ts: 0, turnSeq: -1 } : null;

  for (const message of [...messages].sort(compareTranscriptMessages)) {
    if (message.role === 'user') {
      pendingAfter = message;
    } else if (
      pendingAfter !== null &&
      compareTranscriptOrder(message, pendingAfter) >= 0 &&
      isVisibleResponseActivity(message)
    ) {
      pendingAfter = null;
    }
  }

  return pendingAfter;
}

function ThinkingMessage() {
  return (
    <Message from="assistant" className="chat-reasoning-message">
      <MessageContent>
        <Shimmer className="text-sm font-light" direction="rl" duration={1}>
          Thinking
        </Shimmer>
      </MessageContent>
    </Message>
  );
}

export function FastSessionTranscript({
  sessionId,
  initialMessages,
  hasOlderMessages,
  canReply,
  initialTitle = null,
  fallbackTitle = 'New session',
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
  const openTaskPanel = useOpenSessionTaskPanel();
  const { enabled: narrationModeEnabled } = useNarrationMode();
  const displayMode = narrationModeEnabled ? 'narration' : 'default';
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
  const [pendingResponseAfter, setPendingResponseAfter] =
    useState<TranscriptOrder | null>(() =>
      getPendingResponseOrder(initialMessages),
    );
  const [replyError, setReplyError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(initialTitle);
  usePageTitle(truncatePageTitle(title ?? fallbackTitle));

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
        setPendingResponseAfter((current) => {
          let pendingAfter = current;
          for (const message of [...messages].sort(compareTranscriptMessages)) {
            if (
              message.role === 'user' &&
              (pendingAfter === null ||
                compareTranscriptOrder(message, pendingAfter) >= 0)
            ) {
              pendingAfter = message;
            } else if (
              isVisibleResponseActivity(message) &&
              pendingAfter !== null &&
              compareTranscriptOrder(message, pendingAfter) >= 0
            ) {
              pendingAfter = null;
            }
          }
          return pendingAfter;
        });

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
  const reviewOffers = useMemo(
    () =>
      messages.flatMap((message) => {
        const offer = parsePrReviewActionOffer(message.payload);
        return offer ? [offer] : [];
      }),
    [messages],
  );
  const { renderBlocks, suppressMessage } = useAcpTranscriptBlocks({
    messages: uiMessages,
    artifacts: [],
    displayMode,
    initialPrompt: null,
    shouldHideFirstMessage: false,
    showInternalMessages: false,
    hasLeadingTextBoundary: false,
    keepDelegatedTasksVisible: true,
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
      let previousPendingResponse: TranscriptOrder | null = null;
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
        previousPendingResponse = pendingResponseAfter;
        setPendingResponseAfter(optimistic);
        await trpcClient.fastSessions.reply.mutate({
          sessionId,
          text: prepared.text,
          ...(images.length > 0 ? { images } : {}),
          ...(prepared.attachmentTexts?.length
            ? { attachmentTexts: prepared.attachmentTexts }
            : {}),
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
        setPendingResponseAfter((current) =>
          current?.id === optimisticId ? previousPendingResponse : current,
        );
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [isSending, pendingResponseAfter, sessionId, trpcClient],
  );

  const handleReviewAction = useCallback(
    async (deliveryId: string, choice: PrReviewActionChoice) => {
      const result = await trpcClient.fastSessions.reviewAction.mutate({
        sessionId,
        deliveryId,
        choice,
      });
      return result.status;
    },
    [sessionId, trpcClient],
  );

  return (
    <MessageUiOptionsProvider
      value={{ displayMode, hidePrReviewActions: true }}
    >
      <WorkspaceHeader
        className="py-4.25"
        contentClassName="flex-row items-center gap-3"
      >
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
            onOpenDelegatedTask={openTaskPanel ?? undefined}
          />
          {pendingResponseAfter !== null ? <ThinkingMessage /> : null}
          {reviewOffers.map((offer) => (
            <div
              key={offer.deliveryId}
              className="mt-3 rounded-lg border border-border/70 bg-muted/40 px-3 py-3"
            >
              <p className="mb-2 text-sm">{offer.question}</p>
              <PrReviewActionOffer
                offer={offer}
                onAction={(choice) =>
                  handleReviewAction(offer.deliveryId, choice)
                }
              />
            </div>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {canReply ? (
        <div className="mx-auto w-full shrink-0 overflow-clip rounded-t-md rounded-b-3xl border-2 border-background bg-card transition-colors @[56rem]:rounded-t-lg">
          <SessionPromptInput
            sessionId={sessionId}
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
