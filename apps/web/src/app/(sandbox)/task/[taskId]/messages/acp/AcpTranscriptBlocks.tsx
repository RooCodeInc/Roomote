'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

import { MessageActions, MessageTimestamp } from '@/components/ai-elements';
import { cn } from '@/lib/utils';

import type { TaskSession } from '../../hooks';
import { LazyMessage } from '../../LazyMessage';
import { messageAnchorId } from '../message-anchor';
import {
  buildAcpActivityRenderBlocks,
  type AcpConversationRenderBlock,
} from './activity-groups';
import { AcpActivityGroupMessage } from './AcpActivityGroupMessage';
import { AcpGroupedToolMessage } from './AcpGroupedToolMessage';
import { AcpMessageItem } from './AcpMessageItem';
import { buildAcpRenderBlocks, type AcpRenderBlock } from './render-blocks';
import type { AcpUiMessage } from './types';

type TranscriptDisplayMode = 'default' | 'narration';

export function useAcpTranscriptBlocks({
  messages,
  artifacts,
  displayMode,
  initialPrompt,
  shouldHideFirstMessage,
  showInternalMessages,
  hasLeadingTextBoundary,
  keepDelegatedTasksVisible = false,
  resetKey,
}: {
  messages: AcpUiMessage[];
  artifacts: TaskSession['artifacts'];
  displayMode: TranscriptDisplayMode;
  initialPrompt: AcpUiMessage | null;
  shouldHideFirstMessage: boolean;
  showInternalMessages: boolean;
  hasLeadingTextBoundary: boolean;
  keepDelegatedTasksVisible?: boolean;
  resetKey: string;
}) {
  const [suppressedMessageIds, setSuppressedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setSuppressedMessageIds(new Set());
  }, [resetKey]);

  const suppressMessage = useCallback((messageId: string) => {
    setSuppressedMessageIds((previous) => {
      if (previous.has(messageId)) return previous;

      const next = new Set(previous);
      next.add(messageId);
      return next;
    });
  }, []);

  const renderBlocks = useMemo(() => {
    const blocks = buildAcpRenderBlocks(messages, {
      displayMode,
      initialPrompt,
      shouldHideFirstMessage,
      showInternalMessages,
      keepDelegatedTasksVisible,
      suppressedMessageIds,
    });

    return buildAcpActivityRenderBlocks(blocks, {
      artifacts,
      displayMode,
      hasLeadingTextBoundary,
      keepDelegatedTasksVisible,
    });
  }, [
    artifacts,
    displayMode,
    hasLeadingTextBoundary,
    initialPrompt,
    keepDelegatedTasksVisible,
    messages,
    shouldHideFirstMessage,
    showInternalMessages,
    suppressedMessageIds,
  ]);

  return { renderBlocks, suppressMessage };
}

export function hasVisibleAssistantOutput(
  blocks: AcpConversationRenderBlock[],
): boolean {
  return blocks.some((block) => {
    if (block.kind === 'activity_group') {
      return hasVisibleAssistantOutput(block.blocks);
    }

    if (block.kind === 'tool_group') return false;
    if (block.msg.role === 'assistant') return true;

    return block.childBlocks
      ? hasVisibleAssistantOutput(block.childBlocks)
      : false;
  });
}

export function AcpTranscriptBlockList({
  blocks,
  showInternalMessages,
  onSuppress,
  onOpenDelegatedTask,
}: {
  blocks: AcpConversationRenderBlock[];
  showInternalMessages: boolean;
  onSuppress: (messageId: string) => void;
  onOpenDelegatedTask?: (taskId: string) => void;
}) {
  function renderNestedBlocks(nestedBlocks: AcpRenderBlock[]) {
    return nestedBlocks.map((block) => (
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
          anchorId={messageAnchorId(
            block.kind === 'activity_group' || block.kind === 'tool_group'
              ? block.ts
              : block.msg.ts,
          )}
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

      return wrapRenderedBlock({
        content,
        timestamp,
        nested,
        key: block.id,
        anchorId: messageAnchorId(block.ts),
        forceVisible: block.blocks.some(blockHasPartialMessage),
      });
    }

    if (block.kind === 'tool_group') {
      const content = (
        <AcpGroupedToolMessage
          group={block}
          showSubagentPayload={showInternalMessages}
        />
      );

      return wrapRenderedBlock({
        content,
        timestamp,
        nested,
        key: block.id,
        anchorId: messageAnchorId(block.ts),
        forceVisible: block.items.some((item) => item.msg.partial),
      });
    }

    const content = (
      <AcpMessageItem
        msg={block.msg}
        onSuppress={onSuppress}
        showSubagentPayload={showInternalMessages}
        onOpenDelegatedTask={onOpenDelegatedTask}
      >
        {block.childBlocks?.length
          ? renderNestedBlocks(block.childBlocks)
          : null}
      </AcpMessageItem>
    );

    return wrapRenderedBlock({
      content,
      timestamp,
      nested,
      key: block.msg.id,
      anchorId: messageAnchorId(block.msg.ts),
      forceVisible: block.msg.partial,
    });
  }

  return blocks.map((block) => (
    <Fragment
      key={
        block.kind === 'activity_group' || block.kind === 'tool_group'
          ? block.id
          : block.msg.id
      }
    >
      {renderRenderBlock(block, false)}
    </Fragment>
  ));
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
  if (block.kind === 'activity_group' || block.kind === 'tool_group') {
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

function wrapRenderedBlock({
  content,
  timestamp,
  nested,
  key,
  anchorId,
  forceVisible,
}: {
  content: React.ReactNode;
  timestamp: React.ReactNode;
  nested: boolean;
  key: string;
  anchorId: string;
  forceVisible: boolean;
}) {
  const blockWithTimestamp = (
    <>
      {content}
      {timestamp}
    </>
  );

  return nested ? (
    blockWithTimestamp
  ) : (
    <LazyMessage key={key} anchorId={anchorId} forceVisible={forceVisible}>
      {blockWithTimestamp}
    </LazyMessage>
  );
}

function collectBlockAnchorIds(
  blocks: AcpRenderBlock[],
  excludedAnchorIds: string[] = [],
): string[] {
  const excluded = new Set(excludedAnchorIds);
  const anchorIds: string[] = [];

  const pushAnchor = (anchorId: string) => {
    if (excluded.has(anchorId)) return;

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
