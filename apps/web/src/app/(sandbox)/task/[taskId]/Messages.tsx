'use client';

import {
  memo,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from 'react';
import type { ScrollToBottom } from 'use-stick-to-bottom';

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Message,
  MessageContent,
  Shimmer,
} from '@/components/ai-elements';
import {
  MessageUiOptionsProvider,
  type MessageUiOptions,
} from '@/components/ai-elements/message-ui-options';
import { useNarrationMode } from '@/hooks/useNarrationMode';
import { useMindReaderMode } from '@/hooks/useMindReaderMode';
import { Lightbulb, Skeleton } from '@/components/system';
import { cn } from '@/lib/utils';

import {
  useSandboxMessages,
  useSandboxHistoryReady,
  useSandboxTaskPhase,
  type TaskSession,
} from './hooks';
import { useInternalTranscriptRowsVisible } from './useInternalTranscriptRowsVisible';

import { SleepWakeMessages } from './messages/index';
import {
  AcpTextMessage,
  AcpTranscriptBlockList,
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

function NarrationWorkingReasoningMessage() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, NARRATION_WORKING_REVEAL_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  if (!isVisible) return null;

  return (
    <Message from="assistant" className="chat-reasoning-message">
      <MessageContent>
        <div className="flex items-center gap-2 text-sm font-light text-muted-foreground">
          <Lightbulb className="size-4" />
          <Shimmer direction="rl" duration={1}>
            Thinking...
          </Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
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
  });
  const shouldShowNarrationWorkingReasoning =
    resolvedMessageUiOptions.displayMode === 'narration' &&
    taskPhase === 'running' &&
    !hasVisibleAssistantOutput(renderBlocks);

  return (
    <MessageUiOptionsProvider value={resolvedMessageUiOptions}>
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
          <AcpTranscriptBlockList
            blocks={renderBlocks}
            showInternalMessages={showInternalMessages}
            onSuppress={suppressMessage}
          />
          {session.taskRun && <SleepWakeMessages taskRun={session.taskRun} />}
          {shouldShowNarrationWorkingReasoning && (
            <NarrationWorkingReasoningMessage />
          )}
          {footer}
        </ConversationContent>
        <ConversationScrollButton />
        {scrollRef && <ScrollBridge handleRef={scrollRef} />}
        <ScrollToHash messages={messages} />
      </Conversation>
    </MessageUiOptionsProvider>
  );
};

export const Messages = memo(MessagesBase);

Messages.displayName = 'Messages';
