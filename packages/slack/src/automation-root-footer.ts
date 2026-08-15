import type { SlackBlock } from '@roomote/types';
import { resolveThreadReplyLinkedPrs } from '@roomote/communication';

import type { SlackNotifier } from './slack-notifier';
import {
  AUTOMATION_RESULT_ACTIONS_BLOCK_ID,
  AUTOMATION_RESULT_CONTAINER_BLOCK_ID,
  buildAutomationResultBlocks,
} from './automation-result-blocks';

const AUTOMATION_ROOT_CONTEXT_BLOCK_ID =
  'roomote_late_bound_automation_context';
const AUTOMATION_ROOT_ACTIONS_BLOCK_ID =
  'roomote_late_bound_automation_actions';

export function buildAutomationRootFooterBlocks(params: {
  automationLabel: string;
  taskUrl?: string | null;
  linkedPrUrls?: string[];
}): SlackBlock[] {
  const actionElements: Record<string, unknown>[] = [];
  const linkedPrUrls = params.linkedPrUrls ?? [];

  // Leave room for the task button in Slack's 25-element actions-block limit.
  for (const [index, linkedPrUrl] of linkedPrUrls.slice(0, 24).entries()) {
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
  automationIconUrl: string;
  configureUrl: string;
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
  const typedExistingBlocks = existingBlocks.filter(
    (block): block is SlackBlock =>
      Boolean(
        block &&
        typeof block === 'object' &&
        typeof (block as { type?: unknown }).type === 'string',
      ),
  );

  const linkedPrs = await resolveThreadReplyLinkedPrs({
    taskId: params.taskId ?? null,
    prRepo: params.prRepo ?? null,
    prNumber: params.prNumber ?? null,
  });
  const existingContainer = typedExistingBlocks.find(
    (block) =>
      block.type === 'container' &&
      block.block_id?.startsWith(AUTOMATION_RESULT_CONTAINER_BLOCK_ID),
  );
  const existingSubtitle =
    existingContainer?.type === 'container'
      ? existingContainer.subtitle
      : undefined;
  const contentBlocks = typedExistingBlocks.flatMap((block) => {
    if (
      block.type === 'container' &&
      block.block_id?.startsWith(AUTOMATION_RESULT_CONTAINER_BLOCK_ID)
    ) {
      return block.child_blocks.filter(
        (child) =>
          !(
            child.type === 'actions' &&
            child.block_id?.startsWith(AUTOMATION_RESULT_ACTIONS_BLOCK_ID)
          ),
      );
    }
    return isAutomationRootFooterBlock(block) ? [] : [block];
  });
  const messageTimestamp = Number(params.messageTs.split('.')[0]);

  return (
    (await params.slack.updateMessage({
      channel: params.channelId,
      ts: params.messageTs,
      message: {
        blocks: [
          ...buildAutomationResultBlocks({
            title: params.automationLabel,
            iconUrl: params.automationIconUrl,
            configureUrl: params.configureUrl,
            contentBlocks,
            ...(existingSubtitle ? { subtitle: existingSubtitle } : {}),
            ...(!existingSubtitle && Number.isFinite(messageTimestamp)
              ? { runTimestamp: messageTimestamp }
              : {}),
            taskUrl: params.taskUrl ?? null,
            linkedPrUrls: linkedPrs.map((pr) => pr.prUrl),
          }),
        ],
      },
    })) ?? false
  );
}
