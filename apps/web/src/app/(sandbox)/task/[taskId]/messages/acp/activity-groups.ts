import type { TaskArtifact } from '@/types';

import type {
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
  AcpUiMessage,
} from './types';
import type { AcpRenderBlock } from './render-blocks';
import { resolveVisualProofMediaForToolMessage } from './visual-proof-tool-result';

export const COLLAPSIBLE_ACP_MESSAGE_KINDS = [
  'reasoning',
  'todo_section',
  'tool_call',
  'tool_result',
] as const;

const COLLAPSIBLE_ACP_MESSAGE_KIND_SET = new Set<string>(
  COLLAPSIBLE_ACP_MESSAGE_KINDS,
);

const MANAGE_ARTIFACTS_TOOL_NAME = 'manage_artifacts';

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

function isTextBoundaryBlock(block: AcpRenderBlock): boolean {
  return block.kind === 'message' && block.msg.kind === 'text';
}

function getToolName(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): string | null {
  const rawName = msg.data.toolName ?? msg.data.mcpToolName;
  const normalized = rawName?.trim().toLowerCase();

  return normalized && normalized.length > 0 ? normalized : null;
}

function isArtifactToolMessage(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  artifacts: readonly TaskArtifact[] | null | undefined,
): boolean {
  if (getToolName(msg) === MANAGE_ARTIFACTS_TOOL_NAME) {
    return true;
  }

  return resolveVisualProofMediaForToolMessage(msg, artifacts).length > 0;
}

export function isActivityCollapsibleBlock(
  block: AcpRenderBlock,
  artifacts?: readonly TaskArtifact[] | null,
): boolean {
  if (block.kind === 'tool_group') {
    return !block.items.some((item) =>
      isArtifactToolMessage(item.msg, artifacts),
    );
  }

  const { msg } = block;

  if (!COLLAPSIBLE_ACP_MESSAGE_KIND_SET.has(msg.kind)) {
    return false;
  }

  if (isToolMessage(msg) && isArtifactToolMessage(msg, artifacts)) {
    return false;
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

    if (
      !hasLeftTextBoundary ||
      !isActivityCollapsibleBlock(current, options.artifacts)
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
      isActivityCollapsibleBlock(blocks[activityEnd]!, options.artifacts)
    ) {
      activityEnd += 1;
    }

    const activityBlocks = blocks.slice(activityStart, activityEnd);
    const next = blocks[activityEnd];

    if (activityBlocks.length > 0 && next && isTextBoundaryBlock(next)) {
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
