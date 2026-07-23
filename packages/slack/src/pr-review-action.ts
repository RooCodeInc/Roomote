import type { SlackBlock } from '@roomote/types';

export const PR_REVIEW_ACTION_YES_ACTION_ID = 'pr_review_action_yes';
export const PR_REVIEW_ACTION_AUTO_ACTION_ID = 'pr_review_action_auto';
export const PR_REVIEW_ACTION_DISMISS_ACTION_ID = 'pr_review_action_dismiss';

export function parseSlackPrReviewActionButtonValue(
  value: string | null | undefined,
): { nonce: string } | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as { nonce?: unknown };

    if (typeof parsed.nonce === 'string' && parsed.nonce.length > 0) {
      return { nonce: parsed.nonce };
    }
  } catch {
    // Fall through to null for malformed values.
  }

  return null;
}

/**
 * Body blocks for a PR review-feedback notification that offers to act on the
 * feedback: the summary, the follow-up question, and Yes / auto-handle /
 * Dismiss buttons. The caller appends the sticky thread footer.
 */
export function buildSlackPrReviewActionBlocks(params: {
  /** Summary text already converted to Slack mrkdwn link syntax. */
  text: string;
  question: string;
  nonce: string;
}): SlackBlock[] {
  const value = JSON.stringify({ nonce: params.nonce });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: params.text,
      },
    },
    {
      type: 'section',
      block_id: 'pr_review_action_question',
      text: {
        type: 'mrkdwn',
        text: params.question,
      },
    },
    {
      type: 'actions',
      block_id: 'pr_review_action',
      elements: [
        {
          type: 'button',
          action_id: PR_REVIEW_ACTION_YES_ACTION_ID,
          text: {
            type: 'plain_text',
            text: 'Resolve these issues',
            emoji: true,
          },
          style: 'primary',
          value,
        },
        {
          type: 'button',
          action_id: PR_REVIEW_ACTION_AUTO_ACTION_ID,
          text: {
            type: 'plain_text',
            text: 'Auto-resolve on this PR',
            emoji: true,
          },
          value,
        },
        {
          type: 'button',
          action_id: PR_REVIEW_ACTION_DISMISS_ACTION_ID,
          text: { type: 'plain_text', text: 'Dismiss', emoji: true },
          value,
        },
      ],
    },
  ] as SlackBlock[];
}

const QUESTION_BLOCK_ID = 'pr_review_action_question';
const ACTIONS_BLOCK_ID = 'pr_review_action';

/**
 * Rewrites a posted PR review offer once it is resolved or superseded: the
 * question and button blocks are replaced with a one-line resolution note
 * while every other block (summary, relocated footers) is preserved as-is.
 */
export function buildResolvedSlackPrReviewMessageBlocks(
  originalBlocks: unknown[] | undefined | null,
  resolution: string,
): unknown[] {
  const resolutionBlock = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: resolution }],
  };

  if (!originalBlocks || originalBlocks.length === 0) {
    return [resolutionBlock];
  }

  const kept = originalBlocks.filter((block) => {
    const blockId = (block as { block_id?: unknown }).block_id;

    return blockId !== QUESTION_BLOCK_ID && blockId !== ACTIONS_BLOCK_ID;
  });
  const actionsIndex = originalBlocks.findIndex(
    (block) => (block as { block_id?: unknown }).block_id === ACTIONS_BLOCK_ID,
  );
  // Insert the resolution where the buttons were; fall back to appending.
  const removedBeforeActions = originalBlocks
    .slice(0, actionsIndex < 0 ? 0 : actionsIndex)
    .filter(
      (block) =>
        (block as { block_id?: unknown }).block_id === QUESTION_BLOCK_ID,
    ).length;
  const insertAt =
    actionsIndex < 0 ? kept.length : actionsIndex - removedBeforeActions;

  return [...kept.slice(0, insertAt), resolutionBlock, ...kept.slice(insertAt)];
}
