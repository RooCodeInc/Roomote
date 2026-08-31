import type { SlackBlock, SlackTableCell } from '@roomote/types';

import {
  convertMarkdownInlineToRichText,
  convertMarkdownToRichText,
} from './markdown-rich-text';

export const AUTOMATION_RESULT_CONTAINER_BLOCK_ID =
  'roomote_automation_result_container';
export const AUTOMATION_RESULT_ACTIONS_BLOCK_ID =
  'roomote_automation_result_actions';
// Kept for migrating automation messages created while Markdown reports used
// an uncontained header/content/actions layout.
export const AUTOMATION_RESULT_HEADER_BLOCK_ID =
  'roomote_automation_result_header';
// Kept for removing the settings accessory from messages created before the
// Configure button returned to the actions row.
const AUTOMATION_RESULT_SETTINGS_BLOCK_ID =
  'roomote_automation_result_settings';

const MAX_CONTAINER_CHILDREN = 10;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_CHARACTERS = 10_000;

const AUTOMATION_MARKDOWN_OPTIONS = {
  angleBracketLinkDestinations: true,
} as const;

export function buildAutomationResultContentBlocks(text: string): SlackBlock[] {
  return text.trim() ? [{ type: 'markdown', text }] : [];
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  let codeDelimiterLength: number | null = null;

  for (let index = 0; index < trimmed.length;) {
    const character = trimmed[index] ?? '';
    if (escaped) {
      cell += character;
      escaped = false;
      index += 1;
      continue;
    }
    if (character === '\\') {
      cell += character;
      escaped = true;
      index += 1;
      continue;
    }
    if (character === '`') {
      let delimiterLength = 1;
      while (trimmed[index + delimiterLength] === '`') {
        delimiterLength += 1;
      }
      if (codeDelimiterLength === null) {
        codeDelimiterLength = delimiterLength;
      } else if (codeDelimiterLength === delimiterLength) {
        codeDelimiterLength = null;
      }
      cell += '`'.repeat(delimiterLength);
      index += delimiterLength;
      continue;
    }
    if (character === '|' && codeDelimiterLength === null) {
      cells.push(cell.trim().replaceAll('\\|', '|'));
      cell = '';
      index += 1;
      continue;
    }
    cell += character;
    index += 1;
  }

  cells.push(cell.trim().replaceAll('\\|', '|'));
  return cells;
}

function parseTableAlignment(
  value: string,
): 'left' | 'center' | 'right' | null {
  const trimmed = value.trim();
  if (!/^:?-{3,}:?$/.test(trimmed)) return null;
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
  if (trimmed.endsWith(':')) return 'right';
  return 'left';
}

function buildTableCell(value: string, header: boolean): SlackTableCell {
  const elements = convertMarkdownInlineToRichText(
    value,
    header ? { bold: true } : {},
    AUTOMATION_MARKDOWN_OPTIONS,
  );

  if (elements.length === 0) {
    return { type: 'raw_text', text: ' ' };
  }

  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements }],
  };
}

function parseMarkdownTable(
  lines: string[],
  startIndex: number,
): { block: SlackBlock; nextIndex: number } | null {
  const headerLine = lines[startIndex];
  const alignmentLine = lines[startIndex + 1];
  if (!headerLine?.includes('|') || !alignmentLine?.includes('|')) return null;

  const header = splitTableRow(headerLine);
  const alignments = splitTableRow(alignmentLine).map(parseTableAlignment);
  if (
    header.length === 0 ||
    header.length !== alignments.length ||
    alignments.some((alignment) => alignment === null)
  ) {
    return null;
  }

  const rows = [header];
  let nextIndex = startIndex + 2;
  while (nextIndex < lines.length && lines[nextIndex]?.includes('|')) {
    const row = splitTableRow(lines[nextIndex] ?? '');
    if (row.length !== header.length) break;
    rows.push(row);
    nextIndex += 1;
  }

  const characterCount = rows
    .flat()
    .reduce((sum, value) => sum + value.length, 0);
  if (
    rows.length > MAX_TABLE_ROWS ||
    header.length > MAX_TABLE_COLUMNS ||
    characterCount > MAX_TABLE_CHARACTERS
  ) {
    return null;
  }

  return {
    block: {
      type: 'table',
      column_settings: alignments.map((align) => ({
        align: align ?? 'left',
        is_wrapped: true,
      })),
      rows: rows.map((row, rowIndex) =>
        row.map((value) => buildTableCell(value, rowIndex === 0)),
      ),
    },
    nextIndex,
  };
}

function convertAutomationMarkdownToBlocks(markdown: string): SlackBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: SlackBlock[] = [];
  let prose: string[] = [];
  let fence: { character: string; length: number } | null = null;

  const flushProse = () => {
    const text = prose.join('\n');
    if (text.trim()) {
      blocks.push(convertMarkdownToRichText(text, AUTOMATION_MARKDOWN_OPTIONS));
    }
    prose = [];
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const marker = fenceMatch?.[1];
    if (marker) {
      if (!fence) {
        fence = { character: marker[0] ?? '', length: marker.length };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        !(fenceMatch?.[2] ?? '').trim()
      ) {
        fence = null;
      }
      prose.push(line);
      index += 1;
      continue;
    }

    const table = fence ? null : parseMarkdownTable(lines, index);
    if (table) {
      flushProse();
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    prose.push(line);
    index += 1;
  }

  flushProse();
  return blocks;
}

function normalizeContentBlocks(blocks: SlackBlock[]): SlackBlock[] {
  const normalized: SlackBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'markdown') {
      if (block.text.trim()) {
        normalized.push(...convertAutomationMarkdownToBlocks(block.text));
      }
    } else {
      normalized.push(block);
    }
  }

  return normalized;
}

export function formatAutomationResultSubtitle(params: {
  trigger: string;
  model: string;
  costMicroUsd: number;
  durationMs: number;
}): string {
  const totalSeconds = Math.max(0, Math.floor(params.durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const duration = [
    days > 0 ? `${days}d` : null,
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    `${seconds}s`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
  const price = `$${(Math.max(0, params.costMicroUsd) / 1_000_000).toFixed(2)}`;

  return `${params.trigger} · ${params.model} · ${price} · ${duration}`;
}

export function buildAutomationResultBlocks(params: {
  title: string;
  iconUrl: string;
  configureUrl: string;
  contentText?: string;
  contentBlocks?: SlackBlock[];
  subtitle?: { type: string; text: string };
  taskUrl?: string | null;
  linkedPrUrls?: string[];
  additionalActions?: Record<string, unknown>[];
  configureLabel?: string;
}): SlackBlock[] {
  const actionElements = [...(params.additionalActions ?? [])];
  const linkedPrUrls = params.linkedPrUrls ?? [];
  const reservedActions = actionElements.length + (params.taskUrl ? 1 : 0);

  for (const [index, linkedPrUrl] of linkedPrUrls
    .slice(0, 25 - reservedActions)
    .entries()) {
    actionElements.push({
      type: 'button',
      action_id: `late_bound_automation_view_pr_${index + 1}`,
      text: {
        type: 'plain_text',
        text: linkedPrUrls.length === 1 ? 'See PR' : `See PR ${index + 1}`,
        emoji: false,
      },
      url: linkedPrUrl,
    });
  }

  if (params.taskUrl) {
    actionElements.push({
      type: 'button',
      action_id: 'late_bound_automation_view_task',
      text: { type: 'plain_text', text: 'Go to task', emoji: false },
      url: params.taskUrl,
    });
  }
  actionElements.push({
    type: 'button',
    action_id: 'late_bound_automation_configure',
    text: {
      type: 'plain_text',
      text: params.configureLabel ?? 'Configure',
      emoji: false,
    },
    url: params.configureUrl,
  });
  const configureAction = actionElements.pop();
  const actionGroups =
    actionElements.length === 25 && configureAction
      ? [actionElements, [configureAction]]
      : [[...actionElements, ...(configureAction ? [configureAction] : [])]];

  const contentBlocks = normalizeContentBlocks(
    params.contentBlocks
      ? params.contentBlocks
      : buildAutomationResultContentBlocks(params.contentText ?? ''),
  ).filter(
    (block) =>
      !(
        'block_id' in block &&
        block.block_id === AUTOMATION_RESULT_SETTINGS_BLOCK_ID
      ),
  );

  const groups: SlackBlock[][] = [];
  let remainingBlocks = contentBlocks;
  const finalContentCapacity = MAX_CONTAINER_CHILDREN - actionGroups.length;
  while (remainingBlocks.length > finalContentCapacity) {
    const leadingCount = Math.min(
      MAX_CONTAINER_CHILDREN,
      remainingBlocks.length - finalContentCapacity,
    );
    groups.push(remainingBlocks.slice(0, leadingCount));
    remainingBlocks = remainingBlocks.slice(leadingCount);
  }
  groups.push(remainingBlocks);

  return groups.map((group, index) => ({
    type: 'container',
    width: 'full',
    block_id:
      index === 0
        ? AUTOMATION_RESULT_CONTAINER_BLOCK_ID
        : `${AUTOMATION_RESULT_CONTAINER_BLOCK_ID}_${index + 1}`,
    title: { type: 'plain_text', text: params.title, emoji: false },
    ...(params.subtitle ? { subtitle: params.subtitle } : {}),
    icon: {
      type: 'image',
      image_url: params.iconUrl,
      alt_text: `${params.title} automation icon`,
    },
    has_header_divider: true,
    child_blocks: [
      ...group,
      ...(index === groups.length - 1
        ? actionGroups.map((elements, actionIndex) => ({
            type: 'actions' as const,
            block_id:
              actionIndex === 0
                ? AUTOMATION_RESULT_ACTIONS_BLOCK_ID
                : `${AUTOMATION_RESULT_ACTIONS_BLOCK_ID}_${actionIndex + 1}`,
            elements,
          }))
        : []),
    ],
  }));
}
