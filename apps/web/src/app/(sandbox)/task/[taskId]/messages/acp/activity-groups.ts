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
  live: boolean;
  latestToolMessage?: AcpToolCallUiMessage | AcpToolResultUiMessage;
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
  collapseSettledActivityIds?: ReadonlySet<string>;
  isWorking?: boolean;
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

function closesPrecedingActivitySegment(
  block: AcpRenderBlock,
  artifacts?: readonly TaskArtifact[] | null,
  keepDelegatedTasksVisible = false,
): boolean {
  return (
    isActivityBoundaryBlock(block) ||
    (!isActivityCollapsibleBlock(block, artifacts, keepDelegatedTasksVisible) &&
      !isLiveActivityBlockEligible(block, artifacts, keepDelegatedTasksVisible))
  );
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

function isLiveActivityBlockEligible(
  block: AcpRenderBlock,
  artifacts?: readonly TaskArtifact[] | null,
  keepDelegatedTasksVisible = false,
): boolean {
  if (!isLivePartialBlock(block)) return false;

  if (block.kind === 'tool_group') {
    return block.items.every((item) =>
      isToolEligibleAfterSettlement(
        item.msg,
        artifacts,
        keepDelegatedTasksVisible,
      ),
    );
  }

  if (!isToolMessage(block.msg)) return block.msg.kind === 'reasoning';

  return isToolEligibleAfterSettlement(
    block.msg,
    artifacts,
    keepDelegatedTasksVisible,
  );
}

function isToolEligibleAfterSettlement(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  artifacts?: readonly TaskArtifact[] | null,
  keepDelegatedTasksVisible = false,
): boolean {
  const settledMessage = {
    ...msg,
    partial: false,
    data: { ...msg.data, status: 'completed' as const },
  } as AcpToolCallUiMessage | AcpToolResultUiMessage;

  return (
    resolveToolPresentationPolicy(settledMessage, {
      artifacts,
      delegatedTaskCardsEnabled: keepDelegatedTasksVisible,
    }).activityMode === 'collapsible'
  );
}

function getLatestToolMessage(
  blocks: AcpRenderBlock[],
): AcpToolCallUiMessage | AcpToolResultUiMessage | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'tool_group') return block.items.at(-1)?.msg;
    if (isToolMessage(block.msg)) return block.msg;
  }

  return undefined;
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

  return buildActivitySegmentRenderBlocks(blocks, options);
}

/**
 * Build one activity group per contiguous assistant-work segment. Narrative
 * replies and progress headings are durable boundaries: a live group may grow
 * only until the next such boundary, and the same group ID is retained after
 * that segment settles into "Worked for …".
 */
function buildActivitySegmentRenderBlocks(
  blocks: AcpRenderBlock[],
  options: BuildAcpActivityRenderBlocksOptions,
): AcpConversationRenderBlock[] {
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
      (!isActivityCollapsibleBlock(
        current,
        options.artifacts,
        options.keepDelegatedTasksVisible,
      ) &&
        !isLiveActivityBlockEligible(
          current,
          options.artifacts,
          options.keepDelegatedTasksVisible,
        ))
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
      (isActivityCollapsibleBlock(
        blocks[activityEnd]!,
        options.artifacts,
        options.keepDelegatedTasksVisible,
      ) ||
        isLiveActivityBlockEligible(
          blocks[activityEnd]!,
          options.artifacts,
          options.keepDelegatedTasksVisible,
        ))
    ) {
      activityEnd += 1;
    }

    const liveActivityBlocks = blocks.slice(activityStart, activityEnd);
    const isLive =
      liveActivityBlocks.some(isLivePartialBlock) ||
      (options.isWorking === true && activityEnd === blocks.length);
    if (isLive && activityEnd === blocks.length) {
      const firstActivity = liveActivityBlocks[0]!;
      groupedBlocks.push({
        kind: 'activity_group',
        id: `activity-${getBlockId(firstActivity)}`,
        ts: getBlockTs(firstActivity),
        endTs: getBlockTs(liveActivityBlocks.at(-1)!),
        blocks: liveActivityBlocks,
        live: true,
        latestToolMessage: getLatestToolMessage(liveActivityBlocks),
      });
      cursor = activityEnd;
      continue;
    }

    if (
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

    activityEnd = activityStart;

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
    const activityId = `activity-${getBlockId(activityBlocks[0]!)}`;

    if (
      (countToolCalls(activityBlocks) > 1 ||
        options.collapseSettledActivityIds?.has(activityId)) &&
      next &&
      closesPrecedingActivitySegment(
        next,
        options.artifacts,
        options.keepDelegatedTasksVisible,
      )
    ) {
      const firstActivity = activityBlocks[0]!;

      groupedBlocks.push({
        kind: 'activity_group',
        id: activityId,
        ts: getBlockTs(firstActivity),
        endTs: getBlockTs(next),
        blocks: activityBlocks,
        live: false,
        latestToolMessage: getLatestToolMessage(activityBlocks),
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
