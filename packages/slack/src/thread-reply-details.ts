import type { SlackBlock } from '@roomote/types';

export const ROOMOTE_SLACK_REPLY_TOGGLE_ACTION_ID =
  'toggle_roomote_reply_details';
export const ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID = 'roomote_thread_reply_quote';
export const ROOMOTE_SLACK_REPLY_SUMMARY_BLOCK_ID =
  'roomote_slack_reply_summary';
export const ROOMOTE_SLACK_REPLY_DETAILS_BLOCK_ID =
  'roomote_slack_reply_details';
export const ROOMOTE_SLACK_REPLY_DETAILS_HEADER_BLOCK_ID =
  'roomote_slack_reply_details_header';
export const ROOMOTE_SLACK_REPLY_DETAIL_SECTION_BLOCK_ID_PREFIX =
  'roomote_slack_reply_detail_';
export const ROOMOTE_SLACK_REPLY_ACTIONS_BLOCK_ID =
  'roomote_slack_reply_actions';
const SLACK_MAX_MESSAGE_BLOCKS = 50;

const ROOMOTE_SLACK_REPLY_CONTENT_BLOCK_IDS = new Set([
  ROOMOTE_SLACK_REPLY_SUMMARY_BLOCK_ID,
  ROOMOTE_SLACK_REPLY_DETAILS_BLOCK_ID,
  ROOMOTE_SLACK_REPLY_DETAILS_HEADER_BLOCK_ID,
  ROOMOTE_SLACK_REPLY_ACTIONS_BLOCK_ID,
]);

export interface RoomoteSlackReplyToggleValue {
  taskId: string;
  detailId: string;
  expanded: boolean;
}

export interface RoomoteSlackReplyDetailRecord {
  taskId: string;
  detailId: string;
  summary?: string;
  findings: string[];
}

export interface BuildRoomoteSlackReplyBlocksParams {
  taskId: string;
  detailId: string;
  summary?: string;
  findings: string[];
  expanded: boolean;
  maxBlocks?: number;
}

function buildRoomoteSlackReplyDividerBlock() {
  return {
    type: 'divider' as const,
    block_id: ROOMOTE_SLACK_REPLY_DETAILS_BLOCK_ID,
  };
}

function buildRoomoteSlackReplyDetailsText(findings: string[]): string {
  return findings.map((finding) => `• ${finding}`).join('\n');
}

function buildRoomoteSlackReplyDetailsDivider(): string {
  return '---';
}

function buildRoomoteSlackReplyDetailSectionTexts(params: {
  findings: string[];
  maxDetailBlocks: number;
}): string[] {
  const { findings, maxDetailBlocks } = params;

  if (findings.length === 0 || maxDetailBlocks <= 0) {
    return [];
  }

  if (findings.length <= maxDetailBlocks) {
    return findings.map((finding) => `• ${finding}`);
  }

  const standaloneDetailCount = Math.max(0, maxDetailBlocks - 1);
  const standaloneDetails = findings
    .slice(0, standaloneDetailCount)
    .map((finding) => `• ${finding}`);
  const overflowDetails = findings
    .slice(standaloneDetailCount)
    .map((finding) => `• ${finding}`)
    .join('\n');

  return [...standaloneDetails, overflowDetails];
}

export function formatRoomoteSlackReplySummary(
  summary: string | undefined,
): string | undefined {
  if (!summary || summary.trim().length === 0) {
    return undefined;
  }

  return summary;
}

export function buildRoomoteSlackReplyFallbackText(params: {
  summary?: string;
  findings: string[];
  expanded: boolean;
}): string | undefined {
  const parts = [];
  const summary = formatRoomoteSlackReplySummary(params.summary);

  if (summary) {
    parts.push(summary);
  }

  if (params.expanded && params.findings.length > 0) {
    if (summary) {
      parts.push(buildRoomoteSlackReplyDetailsDivider());
    }
    parts.push(buildRoomoteSlackReplyDetailsText(params.findings));
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export function buildRoomoteSlackReplyToggleValue(
  params: RoomoteSlackReplyToggleValue,
): string {
  return JSON.stringify(params);
}

export function parseRoomoteSlackReplyToggleValue(
  value: string | null | undefined,
): RoomoteSlackReplyToggleValue | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const taskId =
      typeof parsed.taskId === 'string' ? parsed.taskId.trim() : '';
    const detailId =
      typeof parsed.detailId === 'string' ? parsed.detailId.trim() : '';

    if (!taskId || !detailId || typeof parsed.expanded !== 'boolean') {
      return null;
    }

    return {
      taskId,
      detailId,
      expanded: parsed.expanded,
    };
  } catch {
    return null;
  }
}

export function buildRoomoteSlackReplyBlocks(
  params: BuildRoomoteSlackReplyBlocksParams,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const maxBlocks = Math.max(0, params.maxBlocks ?? SLACK_MAX_MESSAGE_BLOCKS);
  const summary = formatRoomoteSlackReplySummary(params.summary);

  if (maxBlocks === 0) {
    return blocks;
  }

  if (summary && blocks.length < maxBlocks) {
    blocks.push({
      type: 'markdown',
      text: summary,
    });
  }

  if (params.expanded && params.findings.length > 0) {
    const needsDivider = Boolean(summary);
    const maxDetailBlocks = Math.max(
      0,
      maxBlocks -
        blocks.length -
        (needsDivider ? 1 : 0) /* divider */ -
        1 /* actions */,
    );
    const detailSectionTexts = buildRoomoteSlackReplyDetailSectionTexts({
      findings: params.findings,
      maxDetailBlocks,
    });

    if (detailSectionTexts.length > 0) {
      if (needsDivider) {
        blocks.push(buildRoomoteSlackReplyDividerBlock());
      }

      blocks.push(
        ...detailSectionTexts.map((text) => ({
          type: 'markdown' as const,
          text,
        })),
      );
    }
  }

  if (params.findings.length > 0 && blocks.length < maxBlocks) {
    blocks.push({
      type: 'actions',
      block_id: ROOMOTE_SLACK_REPLY_ACTIONS_BLOCK_ID,
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: params.expanded ? 'Less ⏶' : 'More ⏷',
            emoji: false,
          },
          action_id: ROOMOTE_SLACK_REPLY_TOGGLE_ACTION_ID,
          value: buildRoomoteSlackReplyToggleValue({
            taskId: params.taskId,
            detailId: params.detailId,
            expanded: params.expanded,
          }),
        },
      ],
    });
  }

  return blocks;
}

export function isRoomoteSlackReplySummaryMarkdownBlock(
  block: unknown,
  summary: string | undefined,
): boolean {
  if (!summary || !block || typeof block !== 'object') {
    return false;
  }

  return (
    (block as { type?: unknown }).type === 'markdown' &&
    (block as { text?: unknown }).text === summary
  );
}

export function isRoomoteSlackReplyContentBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const blockId = (block as { block_id?: unknown }).block_id;
  return (
    typeof blockId === 'string' &&
    (ROOMOTE_SLACK_REPLY_CONTENT_BLOCK_IDS.has(blockId) ||
      blockId.startsWith(ROOMOTE_SLACK_REPLY_DETAIL_SECTION_BLOCK_ID_PREFIX))
  );
}
