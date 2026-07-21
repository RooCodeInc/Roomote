import { getProviderRetryNoticeFromMessageData } from '@roomote/types';

import type { TaskArtifact } from '@/types';

import type {
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
  AcpUiMessage,
} from './types';
import type { AcpRenderBlock } from './render-blocks';
import { resolveShowWidgetForToolMessage } from './show-widget-tool-result';
import { resolveVisualProofMediaForToolMessage } from './visual-proof-tool-result';

const COLLAPSIBLE_ACP_MESSAGE_KINDS = [
  'reasoning',
  'tool_call',
  'tool_result',
] as const;

const COLLAPSIBLE_ACP_MESSAGE_KIND_SET = new Set<string>(
  COLLAPSIBLE_ACP_MESSAGE_KINDS,
);

const MANAGE_ARTIFACTS_TOOL_NAME = 'manage_artifacts';
const SHOW_WIDGET_TOOL_NAME = 'show_widget';
const ROOMOTE_MCP_SERVER_NAME = 'roomote';

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

function getToolName(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): string | null {
  const rawName = msg.data.toolName ?? msg.data.mcpToolName;
  const normalized = rawName?.trim().toLowerCase();

  return normalized && normalized.length > 0 ? normalized : null;
}

function getServerName(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): string | null {
  const rawName = msg.data.serverName ?? msg.data.mcpServerName;
  const normalized = rawName?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function isArtifactToolMessage(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  artifacts: readonly TaskArtifact[] | null | undefined,
): boolean {
  const toolName = getToolName(msg);
  const serverName = getServerName(msg);

  if (toolName === MANAGE_ARTIFACTS_TOOL_NAME) {
    return true;
  }

  if (
    toolName === SHOW_WIDGET_TOOL_NAME &&
    serverName === ROOMOTE_MCP_SERVER_NAME
  ) {
    return true;
  }

  if (resolveShowWidgetForToolMessage(msg) !== null) {
    return true;
  }

  return resolveVisualProofMediaForToolMessage(msg, artifacts).length > 0;
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

export function isActivityCollapsibleBlock(
  block: AcpRenderBlock,
  artifacts?: readonly TaskArtifact[] | null,
): boolean {
  // Keep in-flight reasoning/tool rows outside default-closed groups so current
  // activity stays visible without a manual expand.
  if (isLivePartialBlock(block)) {
    return false;
  }

  if (block.kind === 'tool_group') {
    return !block.items.some((item) =>
      isArtifactToolMessage(item.msg, artifacts),
    );
  }

  const { msg } = block;

  if (isProviderRetryNoticeMessage(msg)) {
    return true;
  }

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

    if (isProgressBoundaryBlock(current)) {
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
