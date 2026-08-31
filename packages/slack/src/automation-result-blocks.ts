import type { SlackBlock } from '@roomote/types';

// Kept for recognizing and migrating automation messages created before
// narrative output moved to top-level Slack markdown blocks.
export const AUTOMATION_RESULT_CONTAINER_BLOCK_ID =
  'roomote_automation_result_container';
export const AUTOMATION_RESULT_ACTIONS_BLOCK_ID =
  'roomote_automation_result_actions';
export const AUTOMATION_RESULT_HEADER_BLOCK_ID =
  'roomote_automation_result_header';
// Kept for removing the dedicated settings section from messages created
// before configuration moved to the content overflow menu.
const AUTOMATION_RESULT_SETTINGS_BLOCK_ID =
  'roomote_automation_result_settings';

const MAX_CONTAINER_CHILDREN = 10;
const MAX_MESSAGE_BLOCKS = 50;

export function buildAutomationResultContentBlocks(text: string): SlackBlock[] {
  return text.trim() ? [{ type: 'markdown', text }] : [];
}

function normalizeContentBlocks(blocks: SlackBlock[]): SlackBlock[] {
  return blocks.flatMap((block) =>
    block.type === 'markdown'
      ? buildAutomationResultContentBlocks(block.text)
      : [block],
  );
}

function buildConfigureOverflow(params: {
  configureUrl: string;
  configureLabel?: string;
}): Record<string, unknown> {
  return {
    type: 'overflow',
    action_id: 'late_bound_automation_configure',
    options: [
      {
        text: {
          type: 'plain_text',
          text: params.configureLabel ?? 'Configure',
          emoji: false,
        },
        url: params.configureUrl,
      },
    ],
  };
}

function attachConfigureOverflow(
  blocks: SlackBlock[],
  overflow: Record<string, unknown>,
): { blocks: SlackBlock[]; attached: boolean } {
  const sectionIndex = blocks.findIndex(
    (block) => block.type === 'section' && !block.accessory,
  );
  if (sectionIndex === -1) return { blocks, attached: false };

  return {
    blocks: blocks.map((block, index) =>
      index === sectionIndex && block.type === 'section'
        ? { ...block, accessory: overflow }
        : block,
    ),
    attached: true,
  };
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
  const normalizedContentBlocks = (
    params.contentBlocks
      ? normalizeContentBlocks(params.contentBlocks)
      : buildAutomationResultContentBlocks(params.contentText ?? '')
  ).filter(
    (block) =>
      !(
        'block_id' in block &&
        block.block_id === AUTOMATION_RESULT_SETTINGS_BLOCK_ID
      ),
  );
  const configureOverflow = buildConfigureOverflow(params);
  const { blocks: contentBlocks, attached: configureOverflowAttached } =
    attachConfigureOverflow(normalizedContentBlocks, configureOverflow);
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
  const configureAction = configureOverflowAttached
    ? undefined
    : configureOverflow;
  const actionGroups =
    actionElements.length === 25 && configureAction
      ? [actionElements, [configureAction]]
      : actionElements.length > 0 || configureAction
        ? [[...actionElements, ...(configureAction ? [configureAction] : [])]]
        : [];

  if (!contentBlocks.some((block) => block.type === 'markdown')) {
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

  const topLevelContentBlocks = contentBlocks.slice(
    0,
    Math.max(0, MAX_MESSAGE_BLOCKS - 1 - actionGroups.length),
  );

  return [
    {
      type: 'context',
      block_id: AUTOMATION_RESULT_HEADER_BLOCK_ID,
      elements: [
        {
          type: 'image',
          image_url: params.iconUrl,
          alt_text: `${params.title} automation icon`,
        },
        { type: 'plain_text', text: params.title, emoji: false },
        ...(params.subtitle ? [params.subtitle] : []),
      ],
    },
    ...topLevelContentBlocks,
    ...actionGroups.map((elements, actionIndex) => ({
      type: 'actions' as const,
      block_id:
        actionIndex === 0
          ? AUTOMATION_RESULT_ACTIONS_BLOCK_ID
          : `${AUTOMATION_RESULT_ACTIONS_BLOCK_ID}_${actionIndex + 1}`,
      elements,
    })),
  ];
}
