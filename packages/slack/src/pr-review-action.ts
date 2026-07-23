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
          text: { type: 'plain_text', text: 'Yes, take a look', emoji: true },
          style: 'primary',
          value,
        },
        {
          type: 'button',
          action_id: PR_REVIEW_ACTION_AUTO_ACTION_ID,
          text: {
            type: 'plain_text',
            text: 'Always auto-handle',
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
