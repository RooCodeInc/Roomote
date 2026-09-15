'use client';

import {
  useCallback,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import {
  useStickToBottomContext,
  type ScrollToBottom,
} from 'use-stick-to-bottom';

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements';
import {
  MessageUiOptionsProvider,
  type MessageUiOptions,
} from '@/components/ai-elements/message-ui-options';
import {
  SlackMentionProvider,
  type SlackMentionScope,
} from '@/components/ai-elements/slack-mention-context';
import { useNarrationMode } from '@/hooks/useNarrationMode';
import { useMindReaderMode } from '@/hooks/useMindReaderMode';
import { Button, Skeleton } from '@/components/system';
import { cn } from '@/lib/utils';

import {
  useSandboxMessages,
  useSandboxHistoryControls,
  useSandboxHistoryReady,
  useSandboxTaskPhase,
  type TaskSession,
} from './hooks';
import { useInternalTranscriptRowsVisible } from './useInternalTranscriptRowsVisible';

import { SleepWakeMessages } from './messages/index';
import {
  AcpTextMessage,
  AcpTranscriptBlockList,
  AcpWorkingMessage,
  hasVisibleAssistantOutput,
  useAcpTranscriptBlocks,
} from './messages/acp';
import { ScrollToHash } from './ScrollToHash';
import { ScrollBridge } from './ScrollBridge';

export interface MessagesHandle {
  scrollToBottom: ScrollToBottom;
}

interface MessagesProps {
  session: TaskSession;
  scrollRef?: MutableRefObject<MessagesHandle | null>;
  initialScrollBehavior?: 'smooth' | 'instant';
  /** Optional content rendered at the end of the conversation (e.g. inline startup progress). */
  footer?: React.ReactNode;
  renderSessionPrompt?: boolean;
  hideFirstAcpUserPrompt?: boolean;
  /** Class name applied to the inner ConversationContent wrapper. */
  conversationClassName?: string;
  /** Conversation-level UI controls consumed by message primitives/actions. */
  messageUiOptions?: MessageUiOptions;
}

const NARRATION_WORKING_REVEAL_DELAY_MS = 700;
const OLDER_HISTORY_TRIGGER_PX = 800;

function DelayedWorkingMessage() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, NARRATION_WORKING_REVEAL_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  if (!isVisible) return null;

  return <AcpWorkingMessage />;
}

function TranscriptSkeleton() {
  return (
    <div aria-label="Loading conversation" className="space-y-6 py-2">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-20 w-4/5 rounded-2xl" />
      </div>
      <div className="ml-auto space-y-2">
        <Skeleton className="ml-auto h-4 w-16" />
        <Skeleton className="ml-auto h-16 w-3/4 rounded-2xl" />
      </div>
    </div>
  );
}

function TranscriptHistoryControls({
  oldestMessageId,
}: {
  oldestMessageId: string | undefined;
}) {
  const {
    isError,
    isRetrying,
    retry,
    hasOlderMessages,
    isFetchingOlderMessages,
    olderMessagesError,
    fetchOlderMessages,
  } = useSandboxHistoryControls();
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const pendingScrollAdjustmentRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const automaticLoadArmedRef = useRef(true);
  const loadInFlightRef = useRef(false);

  useLayoutEffect(() => {
    const pending = pendingScrollAdjustmentRef.current;
    const scrollElement = scrollRef.current;
    if (!pending || !scrollElement) return;

    scrollElement.scrollTop =
      pending.scrollTop + (scrollElement.scrollHeight - pending.scrollHeight);
    pendingScrollAdjustmentRef.current = null;
  }, [oldestMessageId, scrollRef]);

  const loadOlder = useCallback(async () => {
    if (
      !hasOlderMessages ||
      isFetchingOlderMessages ||
      loadInFlightRef.current
    ) {
      return;
    }

    automaticLoadArmedRef.current = false;
    loadInFlightRef.current = true;
    const scrollElement = scrollRef.current;
    if (scrollElement) {
      stopScroll();
      pendingScrollAdjustmentRef.current = {
        scrollHeight: scrollElement.scrollHeight,
        scrollTop: scrollElement.scrollTop,
      };
    }

    try {
      const loaded = await fetchOlderMessages();
      if (!loaded) {
        pendingScrollAdjustmentRef.current = null;
      }
    } finally {
      loadInFlightRef.current = false;
    }
  }, [
    fetchOlderMessages,
    hasOlderMessages,
    isFetchingOlderMessages,
    scrollRef,
    stopScroll,
  ]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    const handleScroll = () => {
      if (scrollElement.scrollTop > OLDER_HISTORY_TRIGGER_PX) {
        automaticLoadArmedRef.current = true;
        return;
      }

      if (
        automaticLoadArmedRef.current &&
        !isError &&
        hasOlderMessages &&
        !isFetchingOlderMessages &&
        !olderMessagesError
      ) {
        void loadOlder();
      }
    };

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [
    hasOlderMessages,
    isError,
    isFetchingOlderMessages,
    loadOlder,
    olderMessagesError,
    scrollRef,
  ]);

  if (isError) {
    return (
      <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
        <span>Conversation history could not be loaded.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isRetrying}
          onClick={() => void retry()}
        >
          {isRetrying ? 'Retrying...' : 'Retry'}
        </Button>
      </div>
    );
  }

  if (!isFetchingOlderMessages && !olderMessagesError) {
    return null;
  }

  return (
    <div className="mb-4 flex flex-col items-center gap-2">
      {isFetchingOlderMessages ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading older messages...
        </p>
      ) : null}
      {olderMessagesError ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadOlder()}
          >
            Retry loading older messages
          </Button>
          <p className="text-xs text-destructive">
            Older messages could not be loaded.
          </p>
        </>
      ) : null}
    </div>
  );
}

const MessagesBase = ({
  session,
  scrollRef,
  initialScrollBehavior = 'smooth',
  footer,
  renderSessionPrompt = true,
  hideFirstAcpUserPrompt,
  conversationClassName = 'mx-auto w-full p-4 max-w-4xl',
  messageUiOptions,
}: MessagesProps) => {
  const { messages } = useSandboxMessages();
  const historyReady = useSandboxHistoryReady();
  const taskPhase = useSandboxTaskPhase();
  const { enabled: mindReaderModeEnabled } = useMindReaderMode();
  const { enabled: narrationModeEnabled } = useNarrationMode();
  const showInternalMessages = useInternalTranscriptRowsVisible();

  const resolvedMessageUiOptions = useMemo(
    () => ({
      ...messageUiOptions,
      displayMode:
        messageUiOptions?.displayMode ??
        (narrationModeEnabled ? 'narration' : 'default'),
      expandReasoningByDefault:
        messageUiOptions?.expandReasoningByDefault ?? mindReaderModeEnabled,
    }),
    [messageUiOptions, mindReaderModeEnabled, narrationModeEnabled],
  );

  // When the URL has a hash anchor, skip the automatic scroll-to-bottom
  // so ScrollToHash can scroll to the linked message instead.
  const hasAnchor =
    typeof window !== 'undefined' && !!window.location.hash.slice(1);
  const sessionPrompt = session.prompt;
  const shouldRenderSessionPrompt =
    renderSessionPrompt &&
    sessionPrompt?.visibleInTranscript !== false &&
    Boolean(sessionPrompt);
  const resolvedHideFirstAcpUserPrompt =
    hideFirstAcpUserPrompt ?? shouldRenderSessionPrompt;
  const { renderBlocks, suppressMessage } = useAcpTranscriptBlocks({
    messages,
    artifacts: session.artifacts,
    displayMode: resolvedMessageUiOptions.displayMode,
    initialPrompt: resolvedHideFirstAcpUserPrompt ? sessionPrompt : null,
    shouldHideFirstMessage: resolvedHideFirstAcpUserPrompt,
    showInternalMessages,
    hasLeadingTextBoundary: shouldRenderSessionPrompt,
    resetKey: session.taskId,
    isWorking: taskPhase === 'running',
  });
  const shouldShowWorking =
    taskPhase === 'running' && !hasVisibleAssistantOutput(renderBlocks);

  const slackMentionScope = useMemo<SlackMentionScope>(
    () => ({ kind: 'task', taskId: session.taskId }),
    [session.taskId],
  );

  return (
    <MessageUiOptionsProvider value={resolvedMessageUiOptions}>
      <SlackMentionProvider scope={slackMentionScope}>
        <Conversation
          className="min-h-0 flex-1"
          initial={hasAnchor ? false : initialScrollBehavior}
        >
          <ConversationContent
            className={cn('ph-no-capture', conversationClassName)}
          >
            {shouldRenderSessionPrompt && sessionPrompt && (
              <AcpTextMessage msg={sessionPrompt} />
            )}
            {!historyReady && <TranscriptSkeleton />}
            {historyReady && (
              <TranscriptHistoryControls oldestMessageId={messages[0]?.id} />
            )}
            <AcpTranscriptBlockList
              blocks={renderBlocks}
              showInternalMessages={showInternalMessages}
              onSuppress={suppressMessage}
            />
            {session.taskRun && <SleepWakeMessages taskRun={session.taskRun} />}
            {shouldShowWorking && <DelayedWorkingMessage />}
            {footer}
          </ConversationContent>
          <ConversationScrollButton />
          {scrollRef && <ScrollBridge handleRef={scrollRef} />}
          <ScrollToHash messages={messages} />
        </Conversation>
      </SlackMentionProvider>
    </MessageUiOptionsProvider>
  );
};

export const Messages = memo(MessagesBase);

Messages.displayName = 'Messages';
