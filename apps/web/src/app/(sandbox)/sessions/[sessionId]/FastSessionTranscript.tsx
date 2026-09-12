'use client';

import { SessionSecrets } from '@/components/sessions/SessionSecrets';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  SETUP_RECEIPT_INPUT_KIND,
  formatRequestUserInputResponseText,
  getImageUrisFromContentBlocks,
  getTextFromContentBlocks,
  inferAcpMessageKind,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputResponsePayload,
  parsePrReviewActionOffer,
  getTaskModelDisplayName,
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
import { VOICE_AUTOSTART_QUERY_PARAM } from '@/lib/voice-autostart';
import { splitSpeakableSentences, toSpeakableText } from '@/lib/voice-speech';
import {
  clearPendingFastSessionLaunch,
  getPendingFastSessionLaunch,
} from '@/lib/pending-fast-session-launch';
import { PrReviewActionOffer } from '@/components/ai-elements/pr-review-action-offer';
import {
  findPendingSessionInputRequest,
  SessionUserInputCard,
} from './SessionUserInputCard';
import { SetupStarterTasksCard } from './setup/SetupStarterTasksCard';
import { SetupIntegrationsCard } from './setup/SetupIntegrationsCard';
import { SESSION_HEADER_CONTENT_CLASS_NAME } from './session-header-layout';
import { isRequestUserInputResponseRepresentedByCanonicalReceipt } from '@/lib/setup-receipt-transcript';

import {
  AcpTranscriptBlockList,
  useAcpTranscriptBlocks,
} from '../../task/[taskId]/messages/acp';
import { ModelBadge } from '@/components/sandbox';
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

function shouldSuppressRequestUserInputToolMessage(
  message: TranscriptMessage,
  requestTurnIds: ReadonlySet<string>,
) {
  if (
    message.eventType !== ACP_ENVELOPE_EVENT_TYPES.ToolCall &&
    message.eventType !== ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
    message.eventType !== ACP_ENVELOPE_EVENT_TYPES.ToolResult
  ) {
    return false;
  }

  const payload = message.payload as {
    toolName?: unknown;
    title?: unknown;
    status?: unknown;
  } | null;
  const isRequestUserInput =
    payload?.toolName === 'request_user_input' ||
    payload?.title === 'request_user_input';
  return (
    isRequestUserInput &&
    payload?.status !== 'failed' &&
    requestTurnIds.has(message.turnId)
  );
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

function buildOptimisticContentBlocks(text: string, images: string[] = []) {
  const imageBlocks: TranscriptMessage['contentBlocks'] = images.flatMap(
    (image) => {
      const match = /^data:(image\/[^;,]+);base64,(.+)$/i.exec(image.trim());
      return match?.[1] && match[2]
        ? [{ type: 'image', mimeType: match[1], data: match[2] }]
        : [];
    },
  );

  return [{ type: 'text' as const, text }, ...imageBlocks];
}

function getInitialOptimisticMessage(
  sessionId: string,
  initialMessages: FastSessionMessage[],
): TranscriptMessage | null {
  const launch = getPendingFastSessionLaunch(sessionId);
  if (!launch) return null;

  const eventId = `web-kickoff:${launch.fastConversationId}:user`;
  if (initialMessages.some((message) => message.eventId === eventId)) {
    clearPendingFastSessionLaunch(sessionId);
    return null;
  }

  return {
    id: eventId,
    eventId,
    turnId: `web-kickoff:${launch.fastConversationId}`,
    turnSeq: 0,
    ts: launch.createdAt,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    role: 'user',
    contentBlocks: buildOptimisticContentBlocks(launch.text, launch.images),
    metadata: { visibleInTranscript: true },
    payload: {},
    source: 'web',
    nativeSessionId: null,
    nativeMessageId: null,
    userName: null,
    userEmail: null,
    userImageUrl: null,
    createdAt: new Date(launch.createdAt),
  };
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

function ThinkingMessage() {
  return (
    <Message from="assistant" className="chat-reasoning-message">
      <MessageContent>
        <Shimmer className="text-sm font-light">Thinking</Shimmer>
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
            <Shimmer as="span" className="text-sm font-light" spread={1}>
              {label}
            </Shimmer>
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
  headerActions,
  secretSessionId,
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
  headerActions?: ReactNode;
  secretSessionId?: string;
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
  const effectiveSessionModel = sessionModel ?? defaultModelId;
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
  const [initialOptimisticMessage] = useState(() =>
    getInitialOptimisticMessage(sessionId, initialMessages),
  );
  const [optimisticMessages, setOptimisticMessages] = useState<
    TranscriptMessage[]
  >(() => (initialOptimisticMessage ? [initialOptimisticMessage] : []));
  const [isSending, setIsSending] = useState(false);
  const [pendingResponseState, dispatchPendingResponse] = useReducer(
    pendingResponseReducer,
    initialOptimisticMessage
      ? [...initialMessages, initialOptimisticMessage]
      : initialMessages,
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
          clearPendingFastSessionLaunch(sessionId);
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
        const fastTurnId = (chunk.metadata as { fastTurnId?: unknown } | null)
          ?.fastTurnId;
        if (typeof fastTurnId === 'string' && fastTurnId) {
          streamTurnIdsRef.current.set(`assistant:${chunk.id}`, fastTurnId);
        }
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

  const pendingInputRequest = useMemo(
    () => findPendingSessionInputRequest(messages),
    [messages],
  );
  const pendingInputRequestOrder = useMemo(() => {
    if (!pendingInputRequest) return null;

    return (
      messages.find((message) => {
        if (message.eventType !== ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
          return false;
        }
        return (
          parseAcpRequestUserInputPayload(message.payload)?.requestId ===
          pendingInputRequest.requestId
        );
      }) ?? null
    );
  }, [messages, pendingInputRequest]);
  const { requestUserInputById, requestUserInputTurnIds } = useMemo(() => {
    const requests = new Map<
      string,
      NonNullable<ReturnType<typeof parseAcpRequestUserInputPayload>>
    >();
    const turnIds = new Set<string>();
    for (const message of messages) {
      if (message.eventType !== ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
        continue;
      }
      const request = parseAcpRequestUserInputPayload(message.payload);
      if (request) {
        requests.set(request.requestId, request);
        turnIds.add(request.turnId);
      }
    }
    return {
      requestUserInputById: requests,
      requestUserInputTurnIds: turnIds,
    };
  }, [messages]);
  const { persistedBeforeInput, persistedAfterInput } = useMemo(() => {
    const before: AcpUiMessage[] = [];
    const after: AcpUiMessage[] = [];

    for (const message of messages) {
      if (
        (message.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
          (message.payload as { taskNavigation?: unknown } | null)
            ?.taskNavigation === true) ||
        message.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput ||
        shouldSuppressRequestUserInputToolMessage(
          message,
          requestUserInputTurnIds,
        )
      ) {
        continue;
      }

      let uiMessage = toAcpUiMessage({
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

      // Keep the persisted source in the UI pipeline so it reconciles the
      // streamed reply in place, but hide this internal voice delivery.
      if (
        message.role === 'assistant' &&
        message.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
        (message.metadata as { voiceCommentary?: unknown } | null)
          ?.voiceCommentary === true
      ) {
        const text = getTranscriptMessageText(message) ?? '';
        uiMessage = toAcpUiMessage({
          id: `assistant:${message.eventId}`,
          ts: message.ts,
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult as AcpEventType,
          role: 'tool',
          kind: 'tool_result',
          contentBlocks: [{ type: 'text', text }],
          metadata: {
            visibleInTranscript: false,
            toolCallId: message.eventId,
          },
          payload: {
            toolName: 'report_to_voice',
            toolCallId: message.eventId,
            status: 'completed',
            rawInput: {},
            output: text,
          },
          text,
          userName: null,
          userEmail: null,
          userImageUrl: null,
        });
      }

      if (
        message.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse
      ) {
        const response = parseAcpRequestUserInputResponsePayload(
          message.payload,
        );
        const requestId =
          response?.requestId ??
          (typeof message.payload?.requestId === 'string'
            ? message.payload.requestId
            : null);
        const request = requestId
          ? (requestUserInputById.get(requestId) ?? null)
          : null;
        if (
          response &&
          isRequestUserInputResponseRepresentedByCanonicalReceipt(
            response,
            messages,
          )
        ) {
          continue;
        }
        uiMessage = {
          ...uiMessage,
          role: 'user',
          kind: 'text',
          text:
            response !== null
              ? formatRequestUserInputResponseText(request, response)
              : (getTranscriptMessageText(message) ??
                'Submitted input response'),
          data: request
            ? { ...(message.payload ?? {}), request }
            : (message.payload ?? {}),
          userId: uiMessage.userId ?? owner?.userId,
          userName: uiMessage.userName ?? owner?.name,
          userEmail: uiMessage.userEmail ?? owner?.email,
          userImageUrl: uiMessage.userImageUrl ?? owner?.imageUrl,
        };
      } else if (
        uiMessage.role === 'user' &&
        owner &&
        uiMessage.userId === owner.userId
      ) {
        uiMessage = {
          ...uiMessage,
          userName: uiMessage.userName ?? owner.name,
          userEmail: uiMessage.userEmail ?? owner.email,
          userImageUrl: uiMessage.userImageUrl ?? owner.imageUrl,
        };
      }

      const target =
        pendingInputRequestOrder &&
        compareTranscriptOrder(message, pendingInputRequestOrder) > 0
          ? after
          : before;
      target.push(uiMessage);
    }

    return {
      persistedBeforeInput: before,
      persistedAfterInput: after,
    };
  }, [
    messages,
    owner,
    pendingInputRequestOrder,
    requestUserInputById,
    requestUserInputTurnIds,
  ]);
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
  const reviewOffers = useMemo(
    () =>
      messages.flatMap((message) => {
        const offer = parsePrReviewActionOffer(message.payload);
        return offer ? [offer] : [];
      }),
    [messages],
  );
  // Words on the call show up as they are spoken, on both sides, and hand
  // over to the persisted voice-turn row once it arrives. A delegated
  // request hands over to the reply's optimistic row instead.
  const [liveVoiceTurns, setLiveVoiceTurns] = useState<{
    user: { text: string; eventId: string | null } | null;
    assistant: { text: string; eventId: string | null } | null;
  }>({ user: null, assistant: null });
  useEffect(() => {
    const settled = (turn: { eventId: string | null } | null) =>
      turn?.eventId !== null &&
      turn?.eventId !== undefined &&
      serverMessages.has(turn.eventId);
    if (settled(liveVoiceTurns.user) || settled(liveVoiceTurns.assistant)) {
      setLiveVoiceTurns((current) => ({
        user: settled(current.user) ? null : current.user,
        assistant: settled(current.assistant) ? null : current.assistant,
      }));
    }
  }, [serverMessages, liveVoiceTurns]);
  const liveVoiceUiMessages = useMemo(() => {
    const turns: AcpUiMessage[] = [];
    const now = Date.now();
    if (liveVoiceTurns.user?.text) {
      turns.push({
        ...toAcpUiMessage({
          id: 'voice-live:user',
          ts: now,
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt as AcpEventType,
          role: 'user',
          kind: 'text',
          contentBlocks: [{ type: 'text', text: liveVoiceTurns.user.text }],
          metadata: { visibleInTranscript: true, voiceTurn: 'heard' },
          payload: {},
          text: liveVoiceTurns.user.text,
          userName: owner?.name ?? null,
          userEmail: owner?.email ?? null,
          userImageUrl: owner?.imageUrl ?? null,
        }),
        partial: liveVoiceTurns.user.eventId === null,
      });
    }
    if (liveVoiceTurns.assistant?.text) {
      turns.push({
        ...toAcpUiMessage({
          id: 'voice-live:assistant',
          ts: now + 1,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage as AcpEventType,
          role: 'assistant',
          kind: 'text',
          contentBlocks: [
            { type: 'text', text: liveVoiceTurns.assistant.text },
          ],
          metadata: { visibleInTranscript: true, voiceTurn: 'spoken' },
          payload: {},
          text: liveVoiceTurns.assistant.text,
          userName: null,
          userEmail: null,
          userImageUrl: null,
        }),
        partial: liveVoiceTurns.assistant.eventId === null,
      });
    }
    return turns;
  }, [liveVoiceTurns, owner]);
  const { uiMessagesBeforeInput, uiMessagesAfterInput } = useMemo(() => {
    if (!pendingInputRequestOrder) {
      return {
        uiMessagesBeforeInput: [
          ...persistedBeforeInput,
          ...persistedAfterInput,
          ...streamMessages,
          ...liveVoiceUiMessages,
        ],
        uiMessagesAfterInput: [],
      };
    }

    const before = [...persistedBeforeInput];
    const after = [...persistedAfterInput];
    for (const message of streamMessages) {
      (message.ts <= pendingInputRequestOrder.ts ? before : after).push(
        message,
      );
    }
    return { uiMessagesBeforeInput: before, uiMessagesAfterInput: after };
  }, [
    pendingInputRequestOrder,
    persistedAfterInput,
    persistedBeforeInput,
    streamMessages,
    liveVoiceUiMessages,
  ]);
  const {
    renderBlocks: renderBlocksBeforeInput,
    suppressMessage: suppressMessageBeforeInput,
  } = useAcpTranscriptBlocks({
    messages: uiMessagesBeforeInput,
    artifacts: [],
    displayMode,
    initialPrompt: null,
    shouldHideFirstMessage: false,
    showInternalMessages: false,
    hasLeadingTextBoundary: false,
    keepDelegatedTasksVisible: true,
    resetKey: `before:${messages.length}:${messages[0]?.eventId ?? ''}:${messages.at(-1)?.eventId ?? ''}`,
  });
  const {
    renderBlocks: renderBlocksAfterInput,
    suppressMessage: suppressMessageAfterInput,
  } = useAcpTranscriptBlocks({
    messages: uiMessagesAfterInput,
    artifacts: [],
    displayMode,
    initialPrompt: null,
    shouldHideFirstMessage: false,
    showInternalMessages: false,
    hasLeadingTextBoundary: false,
    keepDelegatedTasksVisible: true,
    resetKey: `after:${messages.length}:${messages[0]?.eventId ?? ''}:${messages.at(-1)?.eventId ?? ''}`,
  });

  // Every Fast turn started by the call, keyed by its turn id (the client
  // message id), with the GPT-Live delegation it answers (null for a turn
  // the voice did not delegate, such as a typed kickoff). Both streamed
  // chunks and persisted rows carry the turn id, so each piece of a reply is
  // attributed to exactly the delegation that asked for it.
  const voiceDelegationByTurnIdRef = useRef(new Map<string, string | null>());
  // Fast turn id of each streamed reply, from the chunk envelope.
  const streamTurnIdsRef = useRef(new Map<string, string>());
  const sendReply = useCallback(
    async (
      message: SessionPromptSubmission,
      options?: { voiceDelegationId?: string | null },
    ): Promise<boolean> => {
      if (isSending) {
        return false;
      }

      setIsSending(true);
      setReplyError(null);
      let optimisticId: string | null = null;
      let clientMessageId: string | undefined;
      try {
        const prepared = await preparePromptAttachments({
          text: message.text.trim(),
          attachments: message.files,
        });
        const images = prepared.images ?? [];
        if (!prepared.text && images.length === 0) {
          return false;
        }

        if (options?.voiceDelegationId !== undefined) {
          clientMessageId = crypto.randomUUID();
          voiceDelegationByTurnIdRef.current.set(
            clientMessageId,
            options.voiceDelegationId,
          );
        }
        optimisticId = `optimistic:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const optimistic: TranscriptMessage = {
          id: optimisticId,
          eventId: optimisticId,
          turnId: 'optimistic',
          turnSeq: 0,
          ts: Date.now(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          contentBlocks: buildOptimisticContentBlocks(prepared.text, images),
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
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(options?.voiceDelegationId !== undefined
            ? { voiceMode: true }
            : {}),
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
        if (clientMessageId) {
          voiceDelegationByTurnIdRef.current.delete(clientMessageId);
        }
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
  /** Persisted assistant messages already returned to the Live conversation. */
  const spokenSentenceCountsRef = useRef(new Map<string, number>());
  const pendingUtterancesRef = useRef<
    Array<{ text: string; delegationId: string | null }>
  >([]);
  const [utteranceQueueVersion, setUtteranceQueueVersion] = useState(0);

  // Spoken requests between being queued and their reply mutation settling.
  // Counted explicitly so spoken acknowledgements are never recorded in the
  // gap between dequeue and the request actually being sent.
  const [voiceRequestsInFlight, setVoiceRequestsInFlight] = useState(0);
  const enqueueVoiceUtterance = useCallback(
    (text: string, delegationId: string | null) => {
      // The reply's optimistic row takes over from the live speech bubble.
      setLiveVoiceTurns((current) => ({ ...current, user: null }));
      setVoiceRequestsInFlight((count) => count + 1);
      pendingUtterancesRef.current.push({ text, delegationId });
      setUtteranceQueueVersion((version) => version + 1);
    },
    [],
  );

  const recordVoiceTurnRef = useRef<
    (role: 'user' | 'assistant', text: string) => void
  >(() => undefined);
  // GPT-Live acknowledges a request the moment it delegates, before the
  // request itself has been cleaned up and sent. Spoken turns wait until no
  // request is in flight so the acknowledgement lands after what it answers.
  const heldSpokenTurnsRef = useRef<string[]>([]);
  const requestInFlightRef = useRef(false);
  const liveVoice = useLiveVoice({
    onUtterance: enqueueVoiceUtterance,
    onHeardTurn: (text) => recordVoiceTurnRef.current('user', text),
    onSpokenTurn: (text) => {
      if (requestInFlightRef.current) {
        heldSpokenTurnsRef.current.push(text);
        return;
      }
      recordVoiceTurnRef.current('assistant', text);
    },
    onHeardTurnDelta: (text) =>
      setLiveVoiceTurns((current) => ({
        ...current,
        user: { text, eventId: null },
      })),
    onSpokenTurnDelta: (text) =>
      setLiveVoiceTurns((current) => ({
        ...current,
        assistant: { text, eventId: null },
      })),
  });

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

    void sendReply(
      {
        text: next.text,
        files: [],
        model: modelSelectionRef.current.model,
        reasoningEffort: modelSelectionRef.current.reasoningEffort,
      },
      { voiceDelegationId: next.delegationId },
    ).finally(() => {
      setVoiceRequestsInFlight((count) => Math.max(0, count - 1));
    });
  }, [isSending, utteranceQueueVersion, sendReply]);

  const agentWorking =
    isSending ||
    conversationResponding === true ||
    pendingResponseState.pendingAfter !== null;
  const liveVoiceActive = liveVoice.active;
  const speakRef = useRef(liveVoice.speak);
  speakRef.current = liveVoice.speak;

  // Fast's answers to spoken requests are written for the voice, not the
  // screen: they go to GPT-Live as commentary, every completed sentence as
  // soon as it exists while the reply streams, and the persisted row (same
  // id as the stream) finishes the trailing sentence. Progress is tracked per
  // message so nothing is read twice. GPT-Live reports them aloud and its
  // words become the transcript's reply.
  useEffect(() => {
    if (!liveVoiceActive) {
      return;
    }

    const commentary: Array<{
      id: string;
      ts: number;
      text: string;
      partial: boolean;
      delegationId: string | null;
    }> = [];
    for (const message of messages) {
      if (
        message.role === 'assistant' &&
        message.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
        (message.metadata as { voiceCommentary?: unknown } | null)
          ?.voiceCommentary === true
      ) {
        const text = getTranscriptMessageText(message);
        if (text) {
          commentary.push({
            id: `assistant:${message.eventId}`,
            ts: message.ts,
            text,
            partial: false,
            delegationId:
              voiceDelegationByTurnIdRef.current.get(message.turnId) ?? null,
          });
        }
      }
    }
    // A streamed reply is commentary only when its turn was started by the
    // call; that turn's delegation is known from the moment the request was
    // sent, so no sentence is ever attributed to a later request.
    for (const message of streamMessages) {
      if (
        message.role !== 'assistant' ||
        !message.partial ||
        !message.text ||
        message.kind !== 'text'
      ) {
        continue;
      }
      const turnId = streamTurnIdsRef.current.get(message.id);
      if (!turnId || !voiceDelegationByTurnIdRef.current.has(turnId)) {
        continue;
      }
      commentary.push({
        id: message.id,
        ts: message.ts,
        text: message.text,
        partial: true,
        delegationId: voiceDelegationByTurnIdRef.current.get(turnId) ?? null,
      });
    }

    for (const message of commentary) {
      if (message.ts <= voiceCutoffTsRef.current) continue;

      const sentences = splitSpeakableSentences(toSpeakableText(message.text));
      // While streaming, the last sentence may still be growing.
      const readyCount = message.partial
        ? Math.max(sentences.length - 1, 0)
        : sentences.length;
      const spokenCount = spokenSentenceCountsRef.current.get(message.id) ?? 0;
      if (readyCount <= spokenCount) continue;

      spokenSentenceCountsRef.current.set(message.id, readyCount);
      speakRef.current(
        sentences.slice(spokenCount, readyCount).join(' '),
        message.delegationId,
      );
    }
  }, [messages, streamMessages, liveVoiceActive]);

  // The call is transcribed into the Session: what the person said when the
  // voice answered directly, what the voice said, and where the call started
  // and ended. Delegated requests are recorded by the Fast turn they start.
  const recordVoiceTurn = useCallback(
    (role: 'user' | 'assistant', text: string) => {
      // The finished words stay on screen until their persisted row arrives.
      setLiveVoiceTurns((current) => ({
        ...current,
        [role]: { text, eventId: null },
      }));
      void trpcClient.voice.recordTurn
        .mutate({ sessionId, role, text })
        .then(({ eventId }) => {
          setLiveVoiceTurns((current) =>
            current[role]?.text === text
              ? { ...current, [role]: { text, eventId } }
              : current,
          );
        })
        .catch((error: unknown) => {
          console.error('[voice] Failed to record a voice turn', error);
          setLiveVoiceTurns((current) =>
            current[role]?.text === text
              ? { ...current, [role]: null }
              : current,
          );
        });
    },
    [sessionId, trpcClient],
  );
  recordVoiceTurnRef.current = recordVoiceTurn;
  const requestInFlight =
    liveVoice.deliveringUtterances > 0 || voiceRequestsInFlight > 0;
  requestInFlightRef.current = requestInFlight;
  useEffect(() => {
    if (!liveVoiceActive) {
      heldSpokenTurnsRef.current = [];
      setLiveVoiceTurns((current) =>
        current.user === null && current.assistant === null
          ? current
          : { user: null, assistant: null },
      );
      return;
    }
    if (requestInFlight || heldSpokenTurnsRef.current.length === 0) return;
    const held = heldSpokenTurnsRef.current;
    heldSpokenTurnsRef.current = [];
    for (const text of held) recordVoiceTurn('assistant', text);
  }, [liveVoiceActive, requestInFlight, recordVoiceTurn]);
  const callStartedAtRef = useRef<number | null>(null);
  const callEventWriteRef = useRef<Promise<void>>(Promise.resolve());
  const recordVoiceCallEvent = useCallback(
    (event: { phase: 'started' | 'ended'; durationMs?: number }) => {
      const write = callEventWriteRef.current.then(async () => {
        await trpcClient.voice.recordCallEvent.mutate({ sessionId, ...event });
      });
      callEventWriteRef.current = write.catch((error: unknown) => {
        console.error(`[voice] Failed to record call ${event.phase}`, error);
      });
    },
    [sessionId, trpcClient],
  );
  useEffect(() => {
    if (liveVoice.active && liveVoice.startedAt !== null) {
      if (callStartedAtRef.current === liveVoice.startedAt) return;
      callStartedAtRef.current = liveVoice.startedAt;
      recordVoiceCallEvent({ phase: 'started' });
      return;
    }
    if (!liveVoice.active && callStartedAtRef.current !== null) {
      const durationMs = Date.now() - callStartedAtRef.current;
      callStartedAtRef.current = null;
      recordVoiceCallEvent({ phase: 'ended', durationMs });
    }
  }, [liveVoice.active, liveVoice.startedAt, recordVoiceCallEvent]);

  const handleVoiceToggle = useCallback(() => {
    // Toggling while the handshake is still connecting cancels it.
    if (liveVoice.active || liveVoice.status === 'connecting') {
      liveVoice.stop();
      return;
    }

    // Replies that predate the conversation stay silent. The cutoff comes
    // from the transcript's own (server-assigned) timestamps rather than the
    // browser clock, which may run ahead of the server.
    voiceCutoffTsRef.current = 0;
    for (const message of serverMessages.values()) {
      voiceCutoffTsRef.current = Math.max(voiceCutoffTsRef.current, message.ts);
    }
    spokenSentenceCountsRef.current.clear();
    voiceDelegationByTurnIdRef.current.clear();
    pendingUtterancesRef.current = [];
    void liveVoice.start();
  }, [liveVoice, serverMessages]);

  // A session opened from a spoken prompt picks the conversation straight
  // up: voice starts once the deployment confirms it is configured, with no
  // cutoff so the reply to that first utterance is spoken. The flag is
  // dropped from the URL so a reload does not restart the conversation.
  //
  // No "already started" ref guard here: React StrictMode (dev) mounts,
  // unmounts, and remounts effects, and the simulated unmount runs the voice
  // hook's cleanup, which stops the handshake. The effect must be able to
  // start again on the remount, which its dependencies already ensure.
  const startLiveVoiceRef = useRef(liveVoice.start);
  startLiveVoiceRef.current = liveVoice.start;

  useEffect(() => {
    if (!autoStartVoice || !voiceEnabled) {
      return;
    }

    voiceCutoffTsRef.current = 0;
    spokenSentenceCountsRef.current.clear();
    voiceDelegationByTurnIdRef.current.clear();
    // The Session was opened for this call, so a kickoff already in it (text
    // typed before the call) is the voice's turn too, with no delegation.
    for (const message of serverMessagesRef.current.values()) {
      if (message.role === 'user') {
        voiceDelegationByTurnIdRef.current.set(message.turnId, null);
      }
    }
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
          className="py-3.25"
          contentClassName={`${SESSION_HEADER_CONTENT_CLASS_NAME} !flex-row !flex-nowrap`}
          actions={
            <>
              {secretSessionId ? (
                <SessionSecrets
                  key={secretSessionId}
                  sessionId={secretSessionId}
                />
              ) : null}
              {headerActions}
            </>
          }
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1
              className="ph-no-capture min-w-0 truncate cursor-default text-sm font-medium"
              title={title ?? fallbackTitle}
            >
              {title ?? fallbackTitle}
            </h1>
            {(effectiveSessionModel || headerExtras) && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                {effectiveSessionModel ? (
                  <ModelBadge
                    model={effectiveSessionModel}
                    displayName={getTaskModelDisplayName(effectiveSessionModel)}
                    showIcon={false}
                    iconClassName="text-muted-foreground"
                  />
                ) : null}
                {headerExtras}
              </div>
            )}
          </div>
        </WorkspaceHeader>
        <Conversation className="min-h-0 flex-1" initial="instant">
          <ConversationContent className="ph-no-capture mx-auto w-full max-w-4xl p-4 pt-0">
            {hasOlderMessages ? (
              <p className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
                Older messages in this session are not shown.
              </p>
            ) : null}
            <AcpTranscriptBlockList
              blocks={renderBlocksBeforeInput}
              showInternalMessages={false}
              onSuppress={suppressMessageBeforeInput}
              onOpenDelegatedTask={openTaskPanel ?? undefined}
            />
            {pendingInputRequest ? (
              <div className="mt-3">
                {pendingInputRequest.preset === 'setup_starter_tasks' ? (
                  <SetupStarterTasksCard
                    sessionId={sessionId}
                    request={pendingInputRequest}
                  />
                ) : pendingInputRequest.preset === 'setup_integrations' ? (
                  <SetupIntegrationsCard
                    key={pendingInputRequest.requestId}
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
            <AcpTranscriptBlockList
              blocks={renderBlocksAfterInput}
              showInternalMessages={false}
              onSuppress={suppressMessageAfterInput}
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
                offer={offer}
                onAction={(choice) =>
                  handleReviewAction(offer.deliveryId, choice)
                }
              />
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        {canReply && !pendingInputRequest?.preset ? (
          <div className="mx-auto w-full shrink-0 overflow-clip rounded-t-md rounded-b-3xl border-2 border-background bg-card outline-0 outline-offset-[-2px] outline-accent-foreground transition-[background-color,border-color,outline-width] has-[textarea:focus]:outline-2 @[56rem]:rounded-t-lg">
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
                      active:
                        liveVoice.active || liveVoice.status === 'connecting',
                      onToggle: handleVoiceToggle,
                      call: {
                        startedAt: liveVoice.startedAt,
                        micMuted: liveVoice.micMuted,
                        onToggleMic: () =>
                          liveVoice.setMicMuted(!liveVoice.micMuted),
                        outputMuted: liveVoice.outputMuted,
                        onToggleOutput: () =>
                          liveVoice.setOutputMuted(!liveVoice.outputMuted),
                      },
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
