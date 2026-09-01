'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useReducedMotion } from 'motion/react';
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
import {
  useOpenSessionTaskPanel,
  useOpenSessionTasksPanel,
  useSessionRunningTaskCount,
} from './session-task-panel-context';
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

type PendingResponseState = {
  pendingAfter: TranscriptOrder | null;
  latestVisibleResponse: TranscriptOrder | null;
  optimisticRollback: {
    optimisticId: string;
    pendingAfter: TranscriptOrder | null;
  } | null;
};

type PendingResponseAction =
  | { type: 'hydrate'; messages: TranscriptMessage[] }
  | {
      type: 'messages';
      messages: TranscriptMessage[];
      newEventIds: ReadonlySet<string>;
    }
  | { type: 'optimistic'; message: TranscriptOrder }
  | { type: 'commitOptimistic'; optimisticId: string }
  | { type: 'rollbackOptimistic'; optimisticId: string };

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

export function pendingResponseReducer(
  state: PendingResponseState,
  action: PendingResponseAction,
): PendingResponseState {
  if (action.type === 'hydrate' || action.type === 'messages') {
    let pendingAfter =
      action.type === 'hydrate'
        ? action.messages.length === 0
          ? { id: '', ts: 0, turnSeq: -1 }
          : null
        : state.pendingAfter;
    let latestVisibleResponse =
      action.type === 'hydrate' ? null : state.latestVisibleResponse;

    for (const message of [...action.messages].sort(
      compareTranscriptMessages,
    )) {
      const pendingThreshold = pendingAfter ?? latestVisibleResponse;
      const isNewMessage =
        action.type === 'hydrate' || action.newEventIds.has(message.eventId);
      if (
        message.role === 'user' &&
        isNewMessage &&
        (action.type === 'hydrate' ||
          pendingThreshold === null ||
          message.ts >= pendingThreshold.ts)
      ) {
        pendingAfter = message;
      } else if (isNewMessage && isVisibleResponseActivity(message)) {
        if (
          latestVisibleResponse === null ||
          compareTranscriptOrder(message, latestVisibleResponse) >= 0
        ) {
          latestVisibleResponse = message;
        }
        if (
          pendingAfter !== null &&
          compareTranscriptOrder(message, pendingAfter) >= 0
        ) {
          pendingAfter = null;
        }
      }
    }

    return { ...state, pendingAfter, latestVisibleResponse };
  }

  if (action.type === 'optimistic') {
    return {
      pendingAfter: action.message,
      latestVisibleResponse: state.latestVisibleResponse,
      optimisticRollback: {
        optimisticId: action.message.id,
        pendingAfter: state.pendingAfter,
      },
    };
  }

  if (state.optimisticRollback?.optimisticId !== action.optimisticId) {
    return state;
  }

  if (action.type === 'commitOptimistic') {
    return { ...state, optimisticRollback: null };
  }

  return {
    pendingAfter:
      state.pendingAfter?.id === action.optimisticId
        ? state.optimisticRollback.pendingAfter
        : state.pendingAfter,
    latestVisibleResponse: state.latestVisibleResponse,
    optimisticRollback: null,
  };
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

function RunningTasksMessage({
  count,
  onOpenTasks,
}: {
  count: number;
  onOpenTasks: () => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  const label = `${count} ${count === 1 ? 'task' : 'tasks'} running`;

  return (
    <Message from="assistant" className="chat-reasoning-message">
      <MessageContent>
        <span role="status" aria-live="polite">
          <button
            type="button"
            className="w-fit cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={`${label}. Open ${count === 1 ? 'task' : 'tasks'}`}
            onClick={onOpenTasks}
          >
            {shouldReduceMotion ? (
              <span className="text-sm font-light text-muted-foreground">
                {label}
              </span>
            ) : (
              <Shimmer
                as="span"
                className="text-sm font-light"
                duration={3}
                spread={1}
              >
                {label}
              </Shimmer>
            )}
          </button>
        </span>
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
  const openTasksPanel = useOpenSessionTasksPanel();
  const runningTaskCount = useSessionRunningTaskCount();
  const { enabled: narrationModeEnabled } = useNarrationMode();
  const displayMode = narrationModeEnabled ? 'narration' : 'default';
  const [serverMessages, setServerMessages] = useState<
    Map<string, TranscriptMessage>
  >(
    () => new Map(initialMessages.map((message) => [message.eventId, message])),
  );
  const serverMessagesRef = useRef(serverMessages);
  const hasReceivedInitialSessionStateRef = useRef(false);
  const [optimisticMessages, setOptimisticMessages] = useState<
    TranscriptMessage[]
  >([]);
  const [isSending, setIsSending] = useState(false);
  const [pendingResponseState, dispatchPendingResponse] = useReducer(
    pendingResponseReducer,
    initialMessages,
    (messages) =>
      pendingResponseReducer(
        {
          pendingAfter: null,
          latestVisibleResponse: null,
          optimisticRollback: null,
        },
        { type: 'hydrate', messages },
      ),
  );
  const [replyError, setReplyError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(initialTitle);
  const [conversationResponding, setConversationResponding] = useState<
    boolean | null
  >(null);
  usePageTitle(truncatePageTitle(title ?? fallbackTitle));

  useEffect(() => {
    hasReceivedInitialSessionStateRef.current = false;
    const source = new EventSource(`/api/sessions/${sessionId}/stream`);
    const onOpen = () => {
      hasReceivedInitialSessionStateRef.current = false;
    };
    const onMessages = (event: MessageEvent) => {
      try {
        const { messages, conversationResponding: responding } = JSON.parse(
          event.data,
        ) as {
          messages: TranscriptMessage[];
          conversationResponding?: boolean | null;
        };
        const previous = serverMessagesRef.current;
        const canonicalMessages = messages.filter(
          (message) => !previous.has(message.eventId),
        );
        // The stream overlaps the server-rendered transcript on connect. A
        // replayed lease can be stale, so only new output proves that the
        // parent response should suppress hydrated nested-task activity.
        if (
          responding !== undefined &&
          (responding !== true || canonicalMessages.length > 0)
        ) {
          setConversationResponding(responding);
        }
        const canonicalUserMessages = canonicalMessages.filter(
          (message) => message.role === 'user',
        );
        const next = new Map(previous);
        for (const message of messages) {
          next.set(message.eventId, message);
        }
        serverMessagesRef.current = next;
        setServerMessages(next);
        dispatchPendingResponse({
          type: 'messages',
          messages,
          newEventIds: new Set(
            canonicalMessages.map((message) => message.eventId),
          ),
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
        const update = JSON.parse(event.data) as {
          title?: string;
          conversationResponding?: boolean | null;
        };
        if (update.title !== undefined) {
          setTitle(update.title);
        }
        const isInitialSessionState =
          !hasReceivedInitialSessionStateRef.current;
        hasReceivedInitialSessionStateRef.current = true;
        if (
          update.conversationResponding !== undefined &&
          (!isInitialSessionState || update.conversationResponding !== true)
        ) {
          setConversationResponding(update.conversationResponding);
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    source.addEventListener('open', onOpen);
    source.addEventListener('messages', onMessages);
    source.addEventListener('session', onSession);
    return () => {
      source.removeEventListener('open', onOpen);
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

  // Persisted user/assistant history only, matching the server's suggestion
  // cache: optimistic sends must not advance the suggestion query key, and
  // only a completed agent turn (a new assistant message) regenerates.
  const suggestionHistory = useMemo(() => {
    let messageCount = 0;
    let assistantCount = 0;
    for (const message of serverMessages.values()) {
      const isAssistant =
        message.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage;
      if (
        (isAssistant ||
          message.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt) &&
        getTextFromContentBlocks(message.contentBlocks)?.trim()
      ) {
        messageCount += 1;
        if (isAssistant) {
          assistantCount += 1;
        }
      }
    }
    return { messageCount, assistantCount };
  }, [serverMessages]);

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
        dispatchPendingResponse({ type: 'optimistic', message: optimistic });
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
        dispatchPendingResponse({
          type: 'commitOptimistic',
          optimisticId,
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
        if (optimisticId) {
          dispatchPendingResponse({
            type: 'rollbackOptimistic',
            optimisticId,
          });
        }
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [isSending, sessionId, trpcClient],
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
        contentClassName="items-stretch gap-2 pr-12 @[600px]:items-center @[600px]:gap-3 @[600px]:pr-4"
      >
        <h1 className="ph-no-capture min-w-0 flex-1 break-words text-sm font-medium @[600px]:truncate">
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
          {pendingResponseState.pendingAfter !== null ? (
            <ThinkingMessage />
          ) : !isSending &&
            conversationResponding !== true &&
            runningTaskCount > 0 &&
            openTasksPanel ? (
            <RunningTasksMessage
              count={runningTaskCount}
              onOpenTasks={openTasksPanel}
            />
          ) : null}
          {reviewOffers.map((offer) => (
            <PrReviewActionOffer
              key={offer.deliveryId}
              className="mt-3 rounded-lg border border-border/70 bg-muted/40 px-3 py-3"
              offer={offer}
              showQuestion
              onAction={(choice) =>
                handleReviewAction(offer.deliveryId, choice)
              }
            />
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
            historyMessageCount={suggestionHistory.messageCount}
            assistantMessageCount={suggestionHistory.assistantCount}
            agentWorking={
              isSending ||
              conversationResponding === true ||
              pendingResponseState.pendingAfter !== null
            }
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
