import { getRedis } from '@roomote/redis';
import type { SlackBlock } from '@roomote/types';

export const PR_REVIEW_ACTION_YES_ACTION_ID = 'pr_review_action_yes';
export const PR_REVIEW_ACTION_DISMISS_ACTION_ID = 'pr_review_action_dismiss';

const PR_REVIEW_ACTION_PREFIX = 'slack:pr-review-action:';
// The notification stays actionable for a week; after that the buttons report
// the offer as expired and the user falls back to replying in the thread.
const PR_REVIEW_ACTION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Pending state behind a PR review-feedback notification's action buttons.
 * Keyed by a nonce carried in the button value; claimed atomically on the
 * first click so double-clicks and concurrent clickers cannot dispatch the
 * follow-up twice.
 */
export interface PendingSlackPrReviewAction {
  nonce: string;
  taskId: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  channelId: string;
  threadTs: string;
  /**
   * Self-contained imperative instruction injected into the task when the
   * user accepts, written by the notification triage LLM alongside the
   * summary.
   */
  followUpPrompt: string;
}

// GETDEL is atomic: exactly one clicker receives the record; every later
// click sees nil and reports the action as already handled.
const CLAIM_PR_REVIEW_ACTION_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return nil end
redis.call('del', KEYS[1])
return val
`;

function getPrReviewActionKey(nonce: string): string {
  return `${PR_REVIEW_ACTION_PREFIX}${nonce}`;
}

export async function setPendingSlackPrReviewAction(
  pending: PendingSlackPrReviewAction,
): Promise<void> {
  const redis = getRedis();

  await redis.set(
    getPrReviewActionKey(pending.nonce),
    JSON.stringify(pending),
    'EX',
    PR_REVIEW_ACTION_TTL_SECONDS,
  );
}

export async function claimPendingSlackPrReviewAction(
  nonce: string,
): Promise<PendingSlackPrReviewAction | null> {
  const redis = getRedis();
  const raw = await redis.eval(
    CLAIM_PR_REVIEW_ACTION_LUA,
    1,
    getPrReviewActionKey(nonce),
  );

  if (typeof raw !== 'string') {
    return null;
  }

  try {
    return JSON.parse(raw) as PendingSlackPrReviewAction;
  } catch {
    return null;
  }
}

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
 * feedback: the summary, the follow-up question, and Yes/Dismiss buttons. The
 * caller appends the sticky thread footer.
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
          action_id: PR_REVIEW_ACTION_DISMISS_ACTION_ID,
          text: { type: 'plain_text', text: 'Dismiss', emoji: true },
          value,
        },
      ],
    },
  ] as SlackBlock[];
}
