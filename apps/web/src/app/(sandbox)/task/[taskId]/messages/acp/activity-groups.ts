import { getProviderRetryNoticeFromMessageData } from '@roomote/types';

import type { TaskArtifact } from '@/types';

import type {
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
  AcpUiMessage,
} from './types';
import type { AcpRenderBlock } from './render-blocks';
import { resolveToolPresentationPolicy } from './tool-presentation-policy';

const COLLAPSIBLE_ACP_MESSAGE_KINDS = [
  'reasoning',
  'tool_call',
  'tool_result',
] as const;

const COLLAPSIBLE_ACP_MESSAGE_KIND_SET = new Set<string>(
  COLLAPSIBLE_ACP_MESSAGE_KINDS,
);

export interface AcpActivityGroupRenderBlock {
  kind: 'activity_group';
  id: string;
  ts: number;
  endTs: number;
  blocks: AcpRenderBlock[];
}

export type AcpConversationRenderBlock =
  | AcpRenderBlock
  | AcpActivityGroupRenderBlock;

interface BuildAcpActivityRenderBlocksOptions {
  artifacts?: readonly TaskArtifact[] | null;
  displayMode?: 'default' | 'narration';
  hasLeadingTextBoundary?: boolean;
  collapseLeadingActivity?: boolean;
  keepDelegatedTasksVisible?: boolean;
}

function isToolMessage(
  msg: AcpUiMessage,
): msg is AcpToolCallUiMessage | AcpToolResultUiMessage {
  return msg.kind === 'tool_call' || msg.kind === 'tool_result';
}

function getBlockId(block: AcpRenderBlock): string {
  return block.kind === 'tool_group' ? block.id : block.msg.id;
}

function getBlockTs(block: AcpRenderBlock): number {
  return block.kind === 'tool_group' ? block.ts : block.msg.ts;
}

function isProviderRetryNoticeMessage(msg: AcpUiMessage): boolean {
  if (msg.kind !== 'text' || msg.role !== 'assistant') {
    return false;
  }

  return (
    getProviderRetryNoticeFromMessageData(
      msg.data as Record<string, unknown>,
    ) !== null
  );
}

function isProviderRetryNoticeBlock(block: AcpRenderBlock): boolean {
  return block.kind === 'message' && isProviderRetryNoticeMessage(block.msg);
}

function isTextBoundaryBlock(block: AcpRenderBlock): boolean {
  // Provider retry notices are assistant text envelopes, but they are activity
  // rows (status chrome), not narrative turns that should split groups.
  if (isProviderRetryNoticeBlock(block)) {
    return false;
  }

  return block.kind === 'message' && block.msg.kind === 'text';
}

function isProgressBoundaryBlock(block: AcpRenderBlock): boolean {
  return block.kind === 'message' && block.msg.kind === 'todo_section';
}

function isActivityBoundaryBlock(block: AcpRenderBlock): boolean {
  return isTextBoundaryBlock(block) || isProgressBoundaryBlock(block);
}

function isLivePartialBlock(block: AcpRenderBlock): boolean {
  if (block.kind === 'tool_group') {
    return block.items.some(
      (item) =>
        item.msg.partial === true || item.msg.data.status === 'in_progress',
    );
  }

  if (block.msg.partial === true) {
    return true;
  }

  return isToolMessage(block.msg) && block.msg.data.status === 'in_progress';
}

function countToolCalls(blocks: AcpRenderBlock[]): number {
  return blocks.reduce((count, block) => {
    if (block.kind === 'tool_group') return count + block.items.length;
    return count + (isToolMessage(block.msg) ? 1 : 0);
  }, 0);
}

export function isActivityCollapsibleBlock(
  block: AcpRenderBlock,
  artifacts?: readonly TaskArtifact[] | null,
  keepDelegatedTasksVisible = false,
): boolean {
  // Keep in-flight reasoning/tool rows outside default-closed groups so current
  // activity stays visible without a manual expand.
  if (isLivePartialBlock(block)) {
    return false;
  }

  if (block.kind === 'tool_group') {
    return !block.items.some(
      (item) =>
        resolveToolPresentationPolicy(item.msg, {
          artifacts,
          delegatedTaskCardsEnabled: keepDelegatedTasksVisible,
        }).activityMode === 'keep-visible',
    );
  }

  const { msg } = block;

  if (isProviderRetryNoticeMessage(msg)) {
    return true;
  }

  if (!COLLAPSIBLE_ACP_MESSAGE_KIND_SET.has(msg.kind)) {
    return false;
  }

  if (isToolMessage(msg)) {
    return (
      resolveToolPresentationPolicy(msg, {
        artifacts,
        delegatedTaskCardsEnabled: keepDelegatedTasksVisible,
      }).activityMode === 'collapsible'
    );
  }

  return true;
}

export function buildAcpActivityRenderBlocks(
  blocks: AcpRenderBlock[],
  options: BuildAcpActivityRenderBlocksOptions = {},
): AcpConversationRenderBlock[] {
  if (options.displayMode === 'narration') {
    return blocks;
  }

  const groupedBlocks: AcpConversationRenderBlock[] = [];
  let cursor = 0;
  let hasLeftTextBoundary =
    options.hasLeadingTextBoundary === true ||
    options.collapseLeadingActivity !== false;

  while (cursor < blocks.length) {
    const current = blocks[cursor]!;

    if (isTextBoundaryBlock(current)) {
      groupedBlocks.push(current);
      hasLeftTextBoundary = true;
      cursor += 1;
      continue;
    }

    if (isProgressBoundaryBlock(current)) {
      groupedBlocks.push(current);
      hasLeftTextBoundary = true;
      cursor += 1;
      continue;
    }

    if (
      !hasLeftTextBoundary ||
      !isActivityCollapsibleBlock(
        current,
        options.artifacts,
        options.keepDelegatedTasksVisible,
      )
    ) {
      groupedBlocks.push(current);
      hasLeftTextBoundary = false;
      cursor += 1;
      continue;
    }

    const activityStart = cursor;
    let activityEnd = activityStart;

    while (
      activityEnd < blocks.length &&
      isActivityCollapsibleBlock(
        blocks[activityEnd]!,
        options.artifacts,
        options.keepDelegatedTasksVisible,
      )
    ) {
      activityEnd += 1;
    }

    const activityBlocks = blocks.slice(activityStart, activityEnd);
    const next = blocks[activityEnd];

    if (
      countToolCalls(activityBlocks) > 1 &&
      next &&
      isActivityBoundaryBlock(next)
    ) {
      const firstActivity = activityBlocks[0]!;

      groupedBlocks.push({
        kind: 'activity_group',
        id: `activity-${getBlockId(firstActivity)}`,
        ts: getBlockTs(firstActivity),
        endTs: getBlockTs(next),
        blocks: activityBlocks,
      });
      cursor = activityEnd;
      continue;
    }

    groupedBlocks.push(...activityBlocks);
    hasLeftTextBoundary = false;
    cursor = activityEnd;
  }

  return groupedBlocks;
}
