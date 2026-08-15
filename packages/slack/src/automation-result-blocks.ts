import type { SlackBlock } from '@roomote/types';

export const AUTOMATION_RESULT_CONTAINER_BLOCK_ID =
  'roomote_automation_result_container';
export const AUTOMATION_RESULT_ACTIONS_BLOCK_ID =
  'roomote_automation_result_actions';

const MAX_CONTAINER_CHILDREN = 10;
const MAX_SECTION_TEXT_LENGTH = 2900;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_CHARACTERS = 10_000;

type SlackTableCell = {
  type: 'rich_text';
  elements: Array<{
    type: 'rich_text_section';
    elements: Array<Record<string, unknown>>;
  }>;
};

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
      } else if (delimiterLength === codeDelimiterLength) {
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

function parseCodeFence(line: string): {
  character: '`' | '~';
  length: number;
  trailing: string;
} | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const marker = match?.[1];
  if (!marker) return null;
  return {
    character: marker[0] as '`' | '~',
    length: marker.length,
    trailing: match[2] ?? '',
  };
}

function parseAlignment(cell: string): 'left' | 'center' | 'right' | null {
  const trimmed = cell.trim();
  if (!/^:?-{3,}:?$/.test(trimmed)) return null;
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
  if (trimmed.endsWith(':')) return 'right';
  return 'left';
}

function inlineRichTextElements(
  value: string,
  inheritedStyle: Record<string, boolean> = {},
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  let remaining = value;

  const appendText = (text: string, style = inheritedStyle) => {
    if (!text) return;
    elements.push({
      type: 'text',
      text,
      ...(Object.keys(style).length > 0 ? { style } : {}),
    });
  };

  while (remaining) {
    const matches = [
      {
        kind: 'link',
        match: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(remaining),
      },
      { kind: 'bold', match: /\*\*([^*]+)\*\*/.exec(remaining) },
      { kind: 'strike', match: /~~([^~]+)~~/.exec(remaining) },
      { kind: 'code', match: /`([^`]+)`/.exec(remaining) },
      { kind: 'italic', match: /(?<!\*)\*([^*]+)\*(?!\*)/.exec(remaining) },
      { kind: 'italic', match: /_([^_]+)_/.exec(remaining) },
    ].filter(
      (candidate): candidate is { kind: string; match: RegExpExecArray } =>
        candidate.match !== null,
    );
    const next = matches.sort(
      (left, right) => left.match.index - right.match.index,
    )[0];

    if (!next) {
      appendText(remaining);
      break;
    }

    appendText(remaining.slice(0, next.match.index));
    const [matched, content, url] = next.match;
    if (next.kind === 'link') {
      elements.push({
        type: 'link',
        text: content,
        url,
        ...(Object.keys(inheritedStyle).length > 0
          ? { style: inheritedStyle }
          : {}),
      });
    } else {
      const styleKey =
        next.kind === 'strike'
          ? 'strike'
          : next.kind === 'code'
            ? 'code'
            : next.kind;
      elements.push(
        ...inlineRichTextElements(content ?? '', {
          ...inheritedStyle,
          [styleKey]: true,
        }),
      );
    }
    remaining = remaining.slice(next.match.index + matched.length);
  }

  return elements;
}

function buildTableCell(value: string, header: boolean): SlackTableCell {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: inlineRichTextElements(value, header ? { bold: true } : {}),
      },
    ],
  };
}

function parseMarkdownTable(
  lines: string[],
  startIndex: number,
): {
  blocks: SlackBlock[];
  nextIndex: number;
} | null {
  if (startIndex + 1 >= lines.length || !lines[startIndex]?.includes('|')) {
    return null;
  }

  const header = splitTableRow(lines[startIndex] ?? '');
  const alignmentCells = splitTableRow(lines[startIndex + 1] ?? '');
  const alignments = alignmentCells.map(parseAlignment);
  if (
    header.length === 0 ||
    header.length !== alignmentCells.length ||
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
    .reduce((sum, cell) => sum + cell.length, 0);
  if (
    rows.length > MAX_TABLE_ROWS ||
    header.length > MAX_TABLE_COLUMNS ||
    characterCount > MAX_TABLE_CHARACTERS
  ) {
    const tableLines = lines.slice(startIndex, nextIndex);
    const blocks: SlackBlock[] = [];
    let chunk: string[] = [];
    let chunkLength = 0;
    for (const line of tableLines) {
      if (chunk.length > 0 && chunkLength + line.length + 1 > 2700) {
        blocks.push({
          type: 'section',
          width: 'full',
          text: { type: 'mrkdwn', text: `\`\`\`\n${chunk.join('\n')}\n\`\`\`` },
        });
        chunk = [];
        chunkLength = 0;
      }
      chunk.push(line);
      chunkLength += line.length + 1;
    }
    if (chunk.length > 0) {
      blocks.push({
        type: 'section',
        width: 'full',
        text: { type: 'mrkdwn', text: `\`\`\`\n${chunk.join('\n')}\n\`\`\`` },
      });
    }
    return { blocks, nextIndex };
  }

  return {
    blocks: [
      {
        type: 'table',
        column_settings: alignments.map((align) => ({
          align: align ?? 'left',
          is_wrapped: true,
        })),
        rows: rows.map((row, rowIndex) =>
          row.map((cell) => buildTableCell(cell, rowIndex === 0)),
        ),
      },
    ],
    nextIndex,
  };
}

function splitMarkdownText(text: string): SlackBlock[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const blocks: SlackBlock[] = [];
  let remaining = trimmed;
  while (remaining.length > MAX_SECTION_TEXT_LENGTH) {
    const candidate = remaining.slice(0, MAX_SECTION_TEXT_LENGTH);
    const splitAt = Math.max(
      candidate.lastIndexOf('\n\n'),
      candidate.lastIndexOf('\n'),
    );
    const boundary =
      splitAt > MAX_SECTION_TEXT_LENGTH / 2 ? splitAt : MAX_SECTION_TEXT_LENGTH;
    blocks.push({
      type: 'markdown',
      text: remaining.slice(0, boundary).trimEnd(),
    });
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) {
    blocks.push({ type: 'markdown', text: remaining });
  }
  return blocks;
}

export function buildAutomationResultContentBlocks(text: string): SlackBlock[] {
  const lines = text.trim().split('\n');
  const blocks: SlackBlock[] = [];
  let prose: string[] = [];
  let codeFence: { character: '`' | '~'; length: number } | null = null;

  const flushProse = () => {
    blocks.push(...splitMarkdownText(prose.join('\n')));
    prose = [];
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';
    const fence = parseCodeFence(line);
    if (
      fence &&
      (codeFence === null ||
        (fence.character === codeFence.character &&
          fence.length >= codeFence.length &&
          fence.trailing.trim().length === 0))
    ) {
      codeFence = codeFence === null ? fence : null;
      prose.push(line);
      index += 1;
      continue;
    }

    const table = codeFence === null ? parseMarkdownTable(lines, index) : null;
    if (table) {
      flushProse();
      blocks.push(...table.blocks);
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
  return blocks.flatMap((block) => {
    if (block.type === 'markdown') {
      return buildAutomationResultContentBlocks(block.text);
    }
    if (block.type === 'section') {
      return [{ ...block, width: 'full' }];
    }
    return [block];
  });
}

function formatRunTimestamp(runTimestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(runTimestamp * 1000));
}

export function buildAutomationResultBlocks(params: {
  title: string;
  iconUrl: string;
  configureUrl: string;
  contentText?: string;
  contentBlocks?: SlackBlock[];
  runTimestamp?: number;
  subtitle?: { type: string; text: string };
  taskUrl?: string | null;
  linkedPrUrls?: string[];
}): SlackBlock[] {
  const actionElements: Record<string, unknown>[] = [];
  const linkedPrUrls = params.linkedPrUrls ?? [];
  const reservedActions = params.taskUrl ? 1 : 0;

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
    text: { type: 'plain_text', text: 'Configure', emoji: false },
    url: params.configureUrl,
  });
  const configureAction = actionElements.pop();
  const actionGroups =
    actionElements.length === 25 && configureAction
      ? [actionElements, [configureAction]]
      : [[...actionElements, ...(configureAction ? [configureAction] : [])]];

  const contentBlocks = params.contentBlocks
    ? normalizeContentBlocks(params.contentBlocks)
    : buildAutomationResultContentBlocks(params.contentText ?? '');
  const runTimestamp = params.runTimestamp ?? Math.floor(Date.now() / 1000);
  const subtitle = params.subtitle ?? {
    type: 'plain_text',
    text: `Run ${formatRunTimestamp(runTimestamp)}`,
  };

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
    block_id:
      index === 0
        ? AUTOMATION_RESULT_CONTAINER_BLOCK_ID
        : `${AUTOMATION_RESULT_CONTAINER_BLOCK_ID}_${index + 1}`,
    title: { type: 'plain_text', text: params.title, emoji: false },
    subtitle,
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
