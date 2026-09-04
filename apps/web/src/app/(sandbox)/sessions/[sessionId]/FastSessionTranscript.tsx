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
  SETUP_RECEIPT_INPUT_KIND,
  getImageUrisFromContentBlocks,
  getTextFromContentBlocks,
  inferAcpMessageKind,
  parsePrReviewActionOffer,
  type AcpMessage,
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
  LiveVoiceStatusBar,
  Message,
  MessageContent,
  MessageUiOptionsProvider,
  Shimmer,
} from '@/components/ai-elements';
import {
  SlackMentionProvider,
  type SlackMentionScope,
} from '@/components/ai-elements/slack-mention-context';
import { WorkspaceHeader } from '@/components/layout';
import { useLiveVoice } from '@/hooks/useLiveVoice';
import { useVoiceEnabled } from '@/hooks/useVoiceEnabled';
import { findSpeakableBoundary } from '@/lib/voice-speech';
import {
  SessionPromptInput,
  type SessionModelSelection,
  type SessionPromptSubmission,
} from './SessionPromptInput';
import { preparePromptAttachments } from '@/lib/prompt-attachments';
import {
  useOpenSessionTaskPanel,
  useOpenSessionTasksPanel,
  useSessionRunningTaskCount,
  useSessionTaskStateRevision,
} from './session-task-panel-context';
import { useNarrationMode } from '@/hooks/useNarrationMode';
import { usePageTitle } from '@/hooks/usePageTitle';
import { truncatePageTitle } from '@/lib/page-title';
import { PrReviewActionOffer } from '@/components/ai-elements/pr-review-action-offer';
import {
  findPendingSessionInputRequest,
  SessionUserInputCard,
} from './SessionUserInputCard';
import { SetupStarterTasksCard } from './setup/SetupStarterTasksCard';
import {
  SESSION_HEADER_CONTENT_CLASS_NAME,
  SESSION_HEADER_TITLE_CLASS_NAME,
} from './session-header-layout';

import {
  AcpTranscriptBlockList,
  useAcpTranscriptBlocks,
} from '../../task/[taskId]/messages/acp';
import {
  AcpProtocolService,
  toAcpUiMessage,
} from '../../task/[taskId]/hooks/services/acp-protocol-service';
import type { AcpUiMessage } from '../../task/[taskId]/types';

/** Rows arriving over the SSE stream have `createdAt` serialized to a string;
 * the transcript only sorts on ts/turnSeq/id, so both shapes are accepted. */
type TranscriptMessage = Omit<FastSessionMessage, 'createdAt'> & {
  createdAt: Date | string;
};

type TranscriptOrder = Pick<TranscriptMessage, 'id' | 'ts' | 'turnSeq'>;

type TranscriptOwner = {
  userId: string;
  name: string | null;
  email: string | null;
  imageUrl: string | null;
};

const ROOMOTE_KICKOFF_LINK = /\r?\n\r?\n\[Open in Roomote\]\([^\r\n]+\)\s*$/;

function getTranscriptMessageText(message: TranscriptMessage) {
  const text = getTextFromContentBlocks(message.contentBlocks) ?? undefined;
  const payload = message.payload as { kickoff?: unknown } | null;
  return payload?.kickoff === true
    ? text?.replace(ROOMOTE_KICKOFF_LINK, '')
    : text;
}

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
        message.metadata?.inputKind !== SETUP_RECEIPT_INPUT_KIND &&
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

/** Query param that opens a session straight into a voice conversation. */
export const VOICE_AUTOSTART_QUERY_PARAM = 'voice';

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
  owner,
  headerExtras,
  timelineExtras,
  autoStartVoice = false,
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
  owner?: TranscriptOwner;
  headerExtras?: ReactNode;
  timelineExtras?: ReactNode;
  /**
   * Begin a voice conversation as soon as the page loads: set when the
   * session was opened from a voice utterance in the new-session composer,
   * so the first reply is spoken rather than read.
   */
  autoStartVoice?: boolean;
}) {
  const trpcClient = useTRPCClient();
  const openTaskPanel = useOpenSessionTaskPanel();
  const openTasksPanel = useOpenSessionTasksPanel();
  const runningTaskCount = useSessionRunningTaskCount();
  const taskStateRevision = useSessionTaskStateRevision();
  const { enabled: narrationModeEnabled } = useNarrationMode();
  const displayMode = narrationModeEnabled ? 'narration' : 'default';
  const slackMentionScope = useMemo<SlackMentionScope>(
    () => ({ kind: 'session', sessionId }),
    [sessionId],
  );
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
  const streamServiceRef = useRef<AcpProtocolService | null>(null);
  const getStreamService = useCallback(
    () => (streamServiceRef.current ??= new AcpProtocolService()),
    [],
  );
  const [streamMessages, setStreamMessages] = useState<AcpUiMessage[]>([]);
  const streamMessagesRef = useRef(streamMessages);
  const replaceStreamMessages = useCallback((next: AcpUiMessage[]) => {
    streamMessagesRef.current = next;
    setStreamMessages(next);
  }, []);
  const clearStreamMessages = useCallback(() => {
    if (streamMessagesRef.current.length === 0) return;
    getStreamService().reset();
    replaceStreamMessages([]);
  }, [getStreamService, replaceStreamMessages]);

  useEffect(() => {
    hasReceivedInitialSessionStateRef.current = false;
    const source = new EventSource(`/api/sessions/${sessionId}/stream`);
    const onOpen = () => {
      hasReceivedInitialSessionStateRef.current = false;
      // Chunks missed while disconnected cannot be recovered; the persisted
      // row fills the gap.
      clearStreamMessages();
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
        // A persisted reply row supersedes the live text streamed for it.
        const persistedStreamIds = new Set(
          messages
            .filter((message) => message.role === 'assistant')
            .map((message) => `assistant:${message.eventId}`),
        );
        const streamed = streamMessagesRef.current;
        if (streamed.some((message) => persistedStreamIds.has(message.id))) {
          const remaining = streamed.filter(
            (message) => !persistedStreamIds.has(message.id),
          );
          if (remaining.length === 0) {
            getStreamService().reset();
          } else {
            getStreamService().rebindMessages(remaining);
          }
          replaceStreamMessages(remaining);
        }
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
        if (update.conversationResponding === false) {
          // The turn is over: any text no reply delivered is withdrawn.
          clearStreamMessages();
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    // Live reply text arrives as the same `assistant_message_chunk` events
    // the task runtime streams, reassembled by the same protocol service.
    const onChunk = (event: MessageEvent) => {
      try {
        const { event: chunk } = JSON.parse(event.data) as {
          event: AcpMessage;
        };
        if (
          chunk?.eventType !== ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk
        ) {
          return;
        }
        const service = getStreamService();
        let current = streamMessagesRef.current;
        if (
          !current.some((message) => message.id === `assistant:${chunk.id}`)
        ) {
          // A new reply begins: the previous one is complete and only waits
          // for its persisted row.
          const sessionId = chunk.metadata?.sessionId;
          const finalized = service.finalizeActiveStreams(
            current,
            typeof sessionId === 'string' ? sessionId : undefined,
          );
          if (finalized !== current) {
            current = finalized;
            service.rebindMessages(current);
          }
        }
        const result = service.applyOutputEvent(current, chunk);
        if (result) replaceStreamMessages(result.acpMessages);
      } catch {
        // Ignore malformed frames; the persisted row still arrives.
      }
    };
    source.addEventListener('open', onOpen);
    source.addEventListener('messages', onMessages);
    source.addEventListener('session', onSession);
    source.addEventListener('chunk', onChunk);
    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('messages', onMessages);
      source.removeEventListener('session', onSession);
      source.removeEventListener('chunk', onChunk);
      source.close();
    };
  }, [sessionId, clearStreamMessages, getStreamService, replaceStreamMessages]);

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

  const persistedUiMessages = useMemo(
    () =>
      messages
        .filter(
          (message) =>
            message.eventType !== ACP_ENVELOPE_EVENT_TYPES.RequestUserInput &&
            message.eventType !==
              ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
        )
        .map((message) => {
          const uiMessage = toAcpUiMessage({
            // A reply keeps the id its streamed chunks rendered under, so the
            // persisted row reconciles in place instead of remounting.
            id:
              message.role === 'assistant' &&
              message.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage
                ? `assistant:${message.eventId}`
                : message.id,
            ts: message.ts,
            eventType: message.eventType as AcpEventType,
            role: message.role,
            kind: inferAcpMessageKind(message.eventType),
            contentBlocks: message.contentBlocks,
            metadata: message.metadata,
            payload: message.payload,
            text: getTranscriptMessageText(message),
            userName: message.userName,
            userEmail: message.userEmail,
            userImageUrl: message.userImageUrl,
          });

          if (
            uiMessage.role !== 'user' ||
            !owner ||
            uiMessage.userId !== owner.userId
          ) {
            return uiMessage;
          }

          return {
            ...uiMessage,
            userName: uiMessage.userName ?? owner.name,
            userEmail: uiMessage.userEmail ?? owner.email,
            userImageUrl: uiMessage.userImageUrl ?? owner.imageUrl,
          };
        }),
    [messages, owner],
  );
  const hasVisibleAssistantMessage = useMemo(
    () =>
      messages.some(
        (message) =>
          message.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
          message.metadata?.visibleInTranscript !== false &&
          Boolean(getTextFromContentBlocks(message.contentBlocks)?.trim()),
      ),
    [messages],
  );
  const pendingInputRequest = useMemo(
    () => findPendingSessionInputRequest(messages),
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
  const uiMessages = useMemo(
    () =>
      streamMessages.length === 0
        ? persistedUiMessages
        : [...persistedUiMessages, ...streamMessages],
    [persistedUiMessages, streamMessages],
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
          userName: null,
          userEmail: null,
          userImageUrl: null,
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

  // --- Live voice conversation -------------------------------------------

  const voiceEnabled = useVoiceEnabled();
  const modelSelectionRef = useRef<SessionModelSelection>({
    model: sessionModel,
    reasoningEffort: sessionReasoningEffort,
  });
  /** Assistant messages at or before this ts predate the conversation. */
  const voiceCutoffTsRef = useRef(0);
  /**
   * Per assistant message (keyed by transcript id), how many characters of
   * its text have already been handed to speech. `Infinity` marks a reply
   * the user interrupted, which stays silent even as more of it arrives.
   */
  const spokenCursorsRef = useRef(new Map<string, number>());
  const pendingUtterancesRef = useRef<string[]>([]);
  const [utteranceQueueVersion, setUtteranceQueueVersion] = useState(0);

  const enqueueVoiceUtterance = useCallback((text: string) => {
    pendingUtterancesRef.current.push(text);
    setUtteranceQueueVersion((version) => version + 1);
  }, []);

  const liveVoice = useLiveVoice({ onUtterance: enqueueVoiceUtterance });

  // Utterances queue rather than dropping when one lands while the previous
  // reply is still in flight; the queue drains as each send settles.
  useEffect(() => {
    if (isSending) {
      return;
    }

    const next = pendingUtterancesRef.current.shift();

    if (next === undefined) {
      return;
    }

    void sendReply({
      text: next,
      files: [],
      model: modelSelectionRef.current.model,
      reasoningEffort: modelSelectionRef.current.reasoningEffort,
    });
  }, [isSending, utteranceQueueVersion, sendReply]);

  const agentWorking =
    isSending ||
    conversationResponding === true ||
    pendingResponseState.pendingAfter !== null;
  const liveVoiceActive = liveVoice.active;
  const speakRef = useRef(liveVoice.speak);
  speakRef.current = liveVoice.speak;

  // Speak replies as they arrive rather than after the turn settles: each
  // completed sentence of a streaming reply is queued the moment it lands,
  // and whatever remains is queued when the persisted row finalizes it. The
  // per-message cursor means a persisted row that replaces its streamed
  // chunks continues where the stream left off instead of repeating.
  useEffect(() => {
    if (!liveVoiceActive) {
      return;
    }

    for (const message of uiMessages) {
      if (
        message.role !== 'assistant' ||
        message.visibleInTranscript === false ||
        message.ts <= voiceCutoffTsRef.current ||
        !message.text ||
        (message.kind !== 'text' &&
          message.updateType !== ACP_ENVELOPE_EVENT_TYPES.AssistantMessage)
      ) {
        continue;
      }

      const cursor = spokenCursorsRef.current.get(message.id) ?? 0;

      if (cursor === Infinity) {
        continue;
      }

      const boundary = message.partial
        ? findSpeakableBoundary(message.text, cursor)
        : message.text.length;

      if (boundary <= cursor) {
        continue;
      }

      spokenCursorsRef.current.set(message.id, boundary);
      speakRef.current(message.text.slice(cursor, boundary).trim());
    }
  }, [uiMessages, liveVoiceActive]);

  // Talking over a reply drops the rest of it: every reply known at the
  // moment of interruption is muted so later chunks of it stay silent.
  const uiMessagesRef = useRef(uiMessages);
  uiMessagesRef.current = uiMessages;
  const liveVoiceInterruptions = liveVoice.interruptions;

  useEffect(() => {
    if (liveVoiceInterruptions === 0) {
      return;
    }

    for (const message of uiMessagesRef.current) {
      if (message.role === 'assistant') {
        spokenCursorsRef.current.set(message.id, Infinity);
      }
    }
  }, [liveVoiceInterruptions]);

  const handleVoiceToggle = useCallback(() => {
    // Toggling while the handshake is still connecting cancels it.
    if (liveVoice.active || liveVoice.status === 'connecting') {
      liveVoice.stop();
      return;
    }

    // Replies that predate the conversation stay silent. The cutoff comes
    // from the transcript's own (server-assigned) timestamps rather than the
    // browser clock, which may run ahead of the server.
    voiceCutoffTsRef.current = messages.reduce(
      (latest, message) => Math.max(latest, message.ts),
      0,
    );
    spokenCursorsRef.current.clear();
    pendingUtterancesRef.current = [];
    void liveVoice.start();
  }, [liveVoice, messages]);

  // A session opened from a spoken prompt picks the conversation straight
  // up: voice starts once the deployment confirms it is configured, with no
  // cutoff so the reply to that first utterance is spoken. The flag is
  // dropped from the URL so a reload does not restart the conversation.
  const autoStartedVoiceRef = useRef(false);
  const startLiveVoiceRef = useRef(liveVoice.start);
  startLiveVoiceRef.current = liveVoice.start;

  useEffect(() => {
    if (!autoStartVoice || !voiceEnabled || autoStartedVoiceRef.current) {
      return;
    }

    autoStartedVoiceRef.current = true;
    voiceCutoffTsRef.current = 0;
    spokenCursorsRef.current.clear();
    pendingUtterancesRef.current = [];
    void startLiveVoiceRef.current();

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.has(VOICE_AUTOSTART_QUERY_PARAM)) {
        url.searchParams.delete(VOICE_AUTOSTART_QUERY_PARAM);
        window.history.replaceState(window.history.state, '', url);
      }
    }
  }, [autoStartVoice, voiceEnabled]);

  // A structured input request replaces the composer (and with it the voice
  // controls), so end the conversation rather than leaving the microphone
  // open with no way to stop it.
  const liveVoiceConnecting = liveVoice.status === 'connecting';
  const stopLiveVoiceRef = useRef(liveVoice.stop);
  stopLiveVoiceRef.current = liveVoice.stop;

  useEffect(() => {
    if (pendingInputRequest && (liveVoiceActive || liveVoiceConnecting)) {
      stopLiveVoiceRef.current();
    }
  }, [pendingInputRequest, liveVoiceActive, liveVoiceConnecting]);

  return (
    <MessageUiOptionsProvider
      value={{ displayMode, hidePrReviewActions: true }}
    >
      <SlackMentionProvider scope={slackMentionScope}>
        <WorkspaceHeader
          className="py-4.25"
          contentClassName={SESSION_HEADER_CONTENT_CLASS_NAME}
        >
          <h1 className={`ph-no-capture ${SESSION_HEADER_TITLE_CLASS_NAME}`}>
            {title ?? fallbackTitle}
          </h1>
          {headerExtras}
        </WorkspaceHeader>
        <Conversation className="min-h-0 flex-1" initial="instant">
          <ConversationContent className="ph-no-capture mx-auto w-full max-w-4xl p-4 pt-0">
            {hasOlderMessages ? (
              <p className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
                Older messages in this session are not shown.
              </p>
            ) : null}
            <AcpTranscriptBlockList
              blocks={renderBlocks}
              showInternalMessages={false}
              onSuppress={suppressMessage}
              onOpenDelegatedTask={openTaskPanel ?? undefined}
            />
            {hasVisibleAssistantMessage ? timelineExtras : null}
            {pendingResponseState.pendingAfter !== null &&
            streamMessages.length === 0 ? (
              pendingResponseState.pendingAfter.id === '' ? (
                <div className="mt-4">
                  <ThinkingMessage />
                </div>
              ) : (
                <ThinkingMessage />
              )
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
            {pendingInputRequest ? (
              <div className="mt-3">
                {pendingInputRequest.preset === 'setup_starter_tasks' ? (
                  <SetupStarterTasksCard
                    sessionId={sessionId}
                    request={pendingInputRequest}
                  />
                ) : (
                  <SessionUserInputCard
                    sessionId={sessionId}
                    request={pendingInputRequest}
                  />
                )}
              </div>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        {canReply && !pendingInputRequest ? (
          <div className="mx-auto w-full shrink-0 overflow-clip rounded-t-md rounded-b-3xl border-2 border-background bg-card outline-0 outline-offset-[-2px] outline-accent-foreground transition-[background-color,border-color,outline-width] has-[textarea:focus]:outline-2 @[56rem]:rounded-t-lg">
            {liveVoice.status !== 'idle' ? (
              <LiveVoiceStatusBar
                status={liveVoice.status}
                interimTranscript={liveVoice.interimTranscript}
                thinking={agentWorking}
                error={liveVoice.error}
                onStop={liveVoice.stop}
              />
            ) : null}
            <SessionPromptInput
              sessionId={sessionId}
              isBusy={isSending}
              onSend={sendReply}
              historyMessageCount={suggestionHistory.messageCount}
              assistantMessageCount={suggestionHistory.assistantCount}
              taskStateRevision={taskStateRevision}
              agentWorking={agentWorking}
              initialModel={sessionModel}
              initialReasoningEffort={sessionReasoningEffort}
              defaultModelId={defaultModelId}
              defaultReasoningEffort={defaultReasoningEffort}
              voice={
                voiceEnabled
                  ? {
                      enabled: true,
                      active: liveVoice.active,
                      onToggle: handleVoiceToggle,
                    }
                  : undefined
              }
              onModelSelectionChange={(selection) => {
                modelSelectionRef.current = selection;
              }}
            />
            {replyError ? (
              <p className="px-4 pb-2 text-xs text-destructive">{replyError}</p>
            ) : null}
          </div>
        ) : null}
      </SlackMentionProvider>
    </MessageUiOptionsProvider>
  );
}
