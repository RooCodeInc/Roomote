'use client';

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from 'react';
import type { ScrollToBottom } from 'use-stick-to-bottom';

import {
  Message,
  MessageActions,
  MessageContent,
  MessageTimestamp,
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Shimmer,
} from '@/components/ai-elements';
import {
  MessageUiOptionsProvider,
  type MessageUiOptions,
} from '@/components/ai-elements/message-ui-options';
import { useNarrationMode } from '@/hooks/useNarrationMode';
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
  AcpMessageItem,
  AcpGroupedToolMessage,
  AcpActivityGroupMessage,
  AcpTextMessage,
} from './messages/acp';
import {
  buildAcpActivityRenderBlocks,
  type AcpConversationRenderBlock,
} from './messages/acp/activity-groups';
import {
  buildAcpRenderBlocks,
  type AcpRenderBlock,
} from './messages/acp/render-blocks';
import { messageAnchorId } from './messages/message-anchor';
import { LazyMessage } from './LazyMessage';
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

  if (!isVisible) {
    return null;
  }

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

function DebugTimestamp({
  ts,
  previousTs,
  anchorId,
  isUser = false,
}: {
  ts: number;
  previousTs?: number;
  anchorId: string;
  isUser?: boolean;
}) {
  return (
    <MessageActions
      className={cn('md:opacity-100', isUser ? 'justify-end' : 'justify-start')}
    >
      <MessageTimestamp ts={ts} previousTs={previousTs} anchorId={anchorId} />
    </MessageActions>
  );
}

function blockUsesOwnTimestamp(block: AcpConversationRenderBlock): boolean {
  if (block.kind === 'activity_group') {
    return false;
  }

  if (block.kind === 'tool_group') {
    return false;
  }

  switch (block.msg.kind) {
    case 'reasoning':
    case 'todo_section':
    case 'tool_call':
    case 'tool_result':
      return false;
    case 'text':
    case 'plan':
      return true;
    default:
      return true;
  }
}

function hasVisibleAssistantOutput(
  blocks: AcpConversationRenderBlock[],
): boolean {
  return blocks.some((block) => {
    if (block.kind === 'activity_group') {
      return hasVisibleAssistantOutput(block.blocks);
    }

    if (block.kind === 'tool_group') {
      return false;
    }

    if (block.msg.role === 'assistant') {
      return true;
    }

    return block.childBlocks
      ? hasVisibleAssistantOutput(block.childBlocks)
      : false;
  });
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
  const { enabled: narrationModeEnabled } = useNarrationMode();
  const [suppressedMessageIds, setSuppressedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const showInternalMessages = useInternalTranscriptRowsVisible();

  const resolvedMessageUiOptions = useMemo(
    () => ({
      ...messageUiOptions,
      displayMode:
        messageUiOptions?.displayMode ??
        (narrationModeEnabled ? 'narration' : 'default'),
    }),
    [messageUiOptions, narrationModeEnabled],
  );

  useEffect(() => {
    setSuppressedMessageIds(new Set());
  }, [session.taskId]);

  const suppressMessage = useCallback((messageId: string) => {
    setSuppressedMessageIds((prev) => {
      if (prev.has(messageId)) {
        return prev;
      }

      const next = new Set(prev);
      next.add(messageId);
      return next;
    });
  }, []);

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

  const renderBlocks = useMemo(() => {
    const acpBlocks = buildAcpRenderBlocks(messages, {
      displayMode: resolvedMessageUiOptions.displayMode,
      initialPrompt: resolvedHideFirstAcpUserPrompt ? sessionPrompt : null,
      shouldHideFirstMessage: resolvedHideFirstAcpUserPrompt,
      showInternalMessages,
      suppressedMessageIds,
    });

    return buildAcpActivityRenderBlocks(acpBlocks, {
      artifacts: session.artifacts,
      displayMode: resolvedMessageUiOptions.displayMode,
      hasLeadingTextBoundary: shouldRenderSessionPrompt,
    });
  }, [
    messages,
    resolvedHideFirstAcpUserPrompt,
    resolvedMessageUiOptions.displayMode,
    session.artifacts,
    sessionPrompt,
    shouldRenderSessionPrompt,
    showInternalMessages,
    suppressedMessageIds,
  ]);
  const hasVisibleAssistantOutputInTranscript =
    hasVisibleAssistantOutput(renderBlocks);
  const shouldShowNarrationWorkingReasoning =
    resolvedMessageUiOptions.displayMode === 'narration' &&
    taskPhase === 'running' &&
    !hasVisibleAssistantOutputInTranscript;

  function renderNestedBlocks(blocks: AcpRenderBlock[]) {
    return blocks.map((block) => (
      <Fragment key={block.kind === 'tool_group' ? block.id : block.msg.id}>
        {renderRenderBlock(block, true)}
      </Fragment>
    ));
  }

  function renderRenderBlock(
    block: AcpConversationRenderBlock,
    nested: boolean,
  ) {
    const timestamp =
      showInternalMessages && !blockUsesOwnTimestamp(block) ? (
        <DebugTimestamp
          ts={
            block.kind === 'activity_group'
              ? block.ts
              : block.kind === 'tool_group'
                ? block.ts
                : block.msg.ts
          }
          previousTs={
            block.kind === 'activity_group'
              ? block.blocks[0]?.kind === 'tool_group'
                ? block.blocks[0].items[0]?.msg.previousTs
                : block.blocks[0]?.msg.previousTs
              : block.kind === 'tool_group'
                ? block.items[0]?.msg.previousTs
                : block.msg.previousTs
          }
          anchorId={
            block.kind === 'activity_group'
              ? messageAnchorId(block.ts)
              : block.kind === 'tool_group'
                ? messageAnchorId(block.ts)
                : messageAnchorId(block.msg.ts)
          }
          isUser={block.kind === 'message' && block.msg.role === 'user'}
        />
      ) : null;

    if (block.kind === 'activity_group') {
      const content = (
        <AcpActivityGroupMessage
          group={block}
          anchorIds={collectBlockAnchorIds(block.blocks, [
            messageAnchorId(block.ts),
          ])}
        >
          {renderNestedBlocks(block.blocks)}
        </AcpActivityGroupMessage>
      );

      const blockWithTimestamp = (
        <>
          {content}
          {timestamp}
        </>
      );

      return nested ? (
        blockWithTimestamp
      ) : (
        <LazyMessage
          key={block.id}
          anchorId={messageAnchorId(block.ts)}
          forceVisible={block.blocks.some(blockHasPartialMessage)}
        >
          {blockWithTimestamp}
        </LazyMessage>
      );
    }

    if (block.kind === 'tool_group') {
      const content = (
        <AcpGroupedToolMessage
          group={block}
          showSubagentPayload={showInternalMessages}
        />
      );

      const blockWithTimestamp = (
        <>
          {content}
          {timestamp}
        </>
      );

      return nested ? (
        blockWithTimestamp
      ) : (
        <LazyMessage
          key={block.id}
          anchorId={messageAnchorId(block.ts)}
          forceVisible={block.items.some((item) => item.msg.partial)}
        >
          {blockWithTimestamp}
        </LazyMessage>
      );
    }

    const content = (
      <AcpMessageItem
        msg={block.msg}
        onSuppress={suppressMessage}
        showSubagentPayload={showInternalMessages}
      >
        {block.childBlocks?.length
          ? renderNestedBlocks(block.childBlocks)
          : null}
      </AcpMessageItem>
    );

    const blockWithTimestamp = (
      <>
        {content}
        {timestamp}
      </>
    );

    return nested ? (
      blockWithTimestamp
    ) : (
      <LazyMessage
        key={block.msg.id}
        anchorId={messageAnchorId(block.msg.ts)}
        forceVisible={block.msg.partial}
      >
        {blockWithTimestamp}
      </LazyMessage>
    );
  }

  return (
    <MessageUiOptionsProvider value={resolvedMessageUiOptions}>
      <Conversation
        className="min-h-0 flex-1"
        initial={hasAnchor ? false : initialScrollBehavior}
      >
        <ConversationContent className={conversationClassName}>
          {shouldRenderSessionPrompt && sessionPrompt && (
            <AcpTextMessage msg={sessionPrompt} />
          )}
          {!historyReady && <TranscriptSkeleton />}
          {renderBlocks.map((block) => renderRenderBlock(block, false))}
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

function collectBlockAnchorIds(
  blocks: AcpRenderBlock[],
  excludedAnchorIds: string[] = [],
): string[] {
  const excluded = new Set(excludedAnchorIds);
  const anchorIds: string[] = [];

  const pushAnchor = (anchorId: string) => {
    if (excluded.has(anchorId)) {
      return;
    }

    excluded.add(anchorId);
    anchorIds.push(anchorId);
  };

  collectBlockAnchorIdsInto(blocks, pushAnchor);

  return anchorIds;
}

function collectBlockAnchorIdsInto(
  blocks: AcpRenderBlock[],
  pushAnchor: (anchorId: string) => void,
): void {
  for (const block of blocks) {
    if (block.kind === 'tool_group') {
      pushAnchor(messageAnchorId(block.ts));
      for (const item of block.items) {
        pushAnchor(messageAnchorId(item.msg.ts));
      }
      continue;
    }

    pushAnchor(messageAnchorId(block.msg.ts));

    if (block.childBlocks) {
      collectBlockAnchorIdsInto(block.childBlocks, pushAnchor);
    }
  }
}

function blockHasPartialMessage(block: AcpRenderBlock): boolean {
  if (block.kind === 'tool_group') {
    return block.items.some((item) => item.msg.partial);
  }

  return (
    block.msg.partial ||
    Boolean(block.childBlocks?.some(blockHasPartialMessage))
  );
}
