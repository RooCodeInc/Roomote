import type { SlackBlock } from '@roomote/types';
import { resolveThreadReplyLinkedPr } from '@roomote/communication';

import type { SlackNotifier } from './slack-notifier';

const AUTOMATION_ROOT_CONTEXT_BLOCK_ID =
  'roomote_late_bound_automation_context';
const AUTOMATION_ROOT_ACTIONS_BLOCK_ID =
  'roomote_late_bound_automation_actions';

export function buildAutomationRootFooterBlocks(params: {
  automationLabel: string;
  taskUrl?: string | null;
  linkedPrUrl?: string | null;
}): SlackBlock[] {
  const actionElements: Record<string, unknown>[] = [];

  if (params.linkedPrUrl) {
    actionElements.push({
      type: 'button',
      action_id: 'late_bound_automation_view_pr',
      text: {
        type: 'plain_text',
        text: 'See PR',
        emoji: false,
      },
      url: params.linkedPrUrl,
    });
  }

  if (params.taskUrl) {
    actionElements.push({
      type: 'button',
      action_id: 'late_bound_automation_view_task',
      text: {
        type: 'plain_text',
        text: 'Go to task',
        emoji: false,
      },
      url: params.taskUrl,
    });
  }

  return [
    {
      type: 'context',
      block_id: AUTOMATION_ROOT_CONTEXT_BLOCK_ID,
      elements: [
        {
          type: 'plain_text',
          text: `Created via the ${params.automationLabel} automation`,
          emoji: false,
        },
      ],
    },
    ...(actionElements.length > 0
      ? [
          {
            type: 'actions' as const,
            block_id: AUTOMATION_ROOT_ACTIONS_BLOCK_ID,
            elements: actionElements,
          },
        ]
      : []),
  ];
}

function isAutomationRootFooterBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const blockId = (block as { block_id?: unknown }).block_id;
  return (
    blockId === AUTOMATION_ROOT_CONTEXT_BLOCK_ID ||
    blockId === AUTOMATION_ROOT_ACTIONS_BLOCK_ID
  );
}

export async function refreshAutomationRootFooter(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'>;
  channelId: string;
  messageTs: string;
  automationLabel: string;
  taskUrl?: string | null;
  taskId?: string | null;
  prRepo?: string | null;
  prNumber?: number | null;
}): Promise<boolean> {
  const existingBlocks = await params.slack.getMessageBlocks({
    channel: params.channelId,
    messageTs: params.messageTs,
    threadTs: params.messageTs,
  });

  if (!existingBlocks) {
    return false;
  }

  const linkedPr = await resolveThreadReplyLinkedPr({
    taskId: params.taskId ?? null,
    prRepo: params.prRepo ?? null,
    prNumber: params.prNumber ?? null,
  });

  return (
    (await params.slack.updateMessage({
      channel: params.channelId,
      ts: params.messageTs,
      message: {
        blocks: [
          ...existingBlocks.filter(
            (block) => !isAutomationRootFooterBlock(block),
          ),
          ...buildAutomationRootFooterBlocks({
            automationLabel: params.automationLabel,
            taskUrl: params.taskUrl ?? null,
            linkedPrUrl: linkedPr?.prUrl ?? null,
          }),
        ],
      },
    })) ?? false
  );
}
