import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';
import { withThreadReplyFooterLock } from '@roomote/communication/thread-reply-footer-delivery';
import {
  scheduleThreadFooterRefresh,
  forgetThreadFooterRefresh,
  resolveCurrentThreadFooter,
  type ThreadFooterRefreshOutcome,
} from '@roomote/communication';
import {
  refreshThreadFooterCarrier,
  relocateThreadFooterCarrier,
} from '@roomote/communication/thread-footer-carrier-lifecycle';

import { decodeSlackEntity } from './markdown-converter';
import type { SlackNotifier } from './slack-notifier';
import {
  getSlackThreadReplyFooterMessageTs,
  setSlackThreadReplyFooterMessageTs,
} from './slack-messages';
import {
  buildSlackThreadFooterText,
  resolveSlackThreadFooterContext,
} from './thread-footer';

export const SLACK_THREAD_REPLY_FOOTER_BLOCK_ID = 'roomote_thread_reply_footer';

const SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX = 'slack:thread_reply_footer_lock:';

export const THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE =
  'Timed out acquiring thread reply footer lock';

function isSlackThreadReplyFooterText(text: string): boolean {
  return (
    /^Reply anytime(?: · (?:1 task|(?:[2-9]|\d{2,}) tasks) running)?(?: · <[^>]+\|PR #\d+>(?:, <[^>]+\|PR #\d+>)*)? · <[^>]+\|Open in Roomote>$/.test(
      text,
    ) ||
    /^_(?:Reply(?: with @-mention)? or use the <[^>]+\|web app>\.|Working on (?:<[^>]+\|PR(?:\s+#)?\d+>(?:, <[^>]+\|live preview>)?|a <[^>]+\|live preview>), reply(?: with @-mention)? or use the <[^>]+\|web app>\.)_$/.test(
      text,
    )
  );
}

export function isSlackThreadReplyFooterBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const record = block as {
    type?: unknown;
    block_id?: unknown;
    text?: unknown;
    elements?: unknown;
  };

  if (record.block_id === SLACK_THREAD_REPLY_FOOTER_BLOCK_ID) {
    return true;
  }

  if (
    record.type === 'markdown' &&
    typeof record.text === 'string' &&
    isSlackThreadReplyFooterText(record.text)
  ) {
    return true;
  }

  if (record.type !== 'context' || !Array.isArray(record.elements)) {
    return false;
  }

  return record.elements.some((element) => {
    if (!element || typeof element !== 'object') {
      return false;
    }

    const contextElement = element as { type?: unknown; text?: unknown };
    return (
      contextElement.type === 'mrkdwn' &&
      typeof contextElement.text === 'string' &&
      isSlackThreadReplyFooterText(contextElement.text)
    );
  });
}

export function buildSlackThreadReplyFooterBlock(params: {
  footerText: string;
}): {
  type: 'context';
  block_id: string;
  elements: [{ type: 'mrkdwn'; text: string }];
} {
  return {
    type: 'context',
    block_id: SLACK_THREAD_REPLY_FOOTER_BLOCK_ID,
    elements: [
      {
        type: 'mrkdwn',
        text: params.footerText,
      },
    ],
  };
}

function readSlackThreadReplyFooter(blocks: unknown[]): {
  index: number;
  text: string;
} | null {
  const index = blocks.findIndex(isSlackThreadReplyFooterBlock);
  if (index < 0) return null;
  const block = blocks[index] as {
    text?: string;
    elements?: { text?: string }[];
  };
  const posted =
    block.elements?.find((element) => typeof element.text === 'string')?.text ??
    block.text;
  return posted ? { index, text: decodeSlackEntity(posted) } : null;
}

export async function withSlackThreadReplyFooterLock<T>(params: {
  channel: string;
  threadTs: string;
  maxAcquireAttempts?: number;
  fn: (assertLock: () => Promise<void>) => Promise<T>;
}): Promise<T> {
  return withThreadReplyFooterLock({
    lockKey: `${SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX}${params.channel}:${params.threadTs}`,
    maxAcquireAttempts: params.maxAcquireAttempts,
    fn: params.fn,
  });
}

export async function removeSlackThreadReplyFooter(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'>;
  channel: string;
  threadTs: string;
  messageTs: string;
  assertLock?: () => Promise<void>;
}): Promise<void> {
  const blocks = await params.slack.getMessageBlocks({
    channel: params.channel,
    messageTs: params.messageTs,
    threadTs: params.threadTs,
  });

  if (!blocks) {
    return;
  }

  const updatedBlocks = blocks.filter(
    (block) => !isSlackThreadReplyFooterBlock(block),
  );

  if (updatedBlocks.length === blocks.length) {
    return;
  }

  await params.assertLock?.();
  const updated = await params.slack.updateMessage({
    channel: params.channel,
    ts: params.messageTs,
    message: { blocks: updatedBlocks },
  });

  if (!updated) {
    console.error(
      `[slackThreadFooter] Failed to remove footer from prior Slack message ${params.messageTs}`,
    );
  }
}

function buildOutOfBandTaskUrl(taskId: string, utmCampaign: string): string {
  const url = new URL(`${Env.R_APP_URL}/task/${taskId}`);
  url.searchParams.set('utm_source', 'slack');
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', utmCampaign);
  return url.toString();
}

async function relocateSlackThreadFooter<TResult>(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'> &
    Partial<Pick<SlackNotifier, 'getWorkspaceId'>>;
  channel: string;
  threadTs: string;
  publish: () => Promise<{ messageId: string; result: TResult } | null>;
}): Promise<TResult | null> {
  return relocateThreadFooterCarrier({
    lockKey: `${SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX}${params.channel}:${params.threadTs}`,
    read: async () => {
      const messageId = await getSlackThreadReplyFooterMessageTs(
        params.channel,
        params.threadTs,
      );
      return messageId ? { messageId } : null;
    },
    sameVersion: (current, seen) => current?.messageId === seen?.messageId,
    publish: async () => {
      const published = await params.publish();
      return published
        ? {
            carrier: { messageId: published.messageId },
            result: published.result,
          }
        : null;
    },
    remember: (carrier, lock) =>
      setSlackThreadReplyFooterMessageTs(
        params.channel,
        params.threadTs,
        carrier.messageId,
        { lock },
      ),
    afterRemember: (_carrier, assertLock) =>
      rememberSlackThreadFooterRefresh(params, assertLock),
    clearFooter: (carrier) =>
      removeSlackThreadReplyFooter({
        slack: params.slack,
        channel: params.channel,
        threadTs: params.threadTs,
        messageTs: carrier.messageId,
      }),
    onRememberError: (carrier, error) => {
      console.error(
        `[slackThreadFooter] Failed to persist latest footer message ts ${carrier.messageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    onClearError: (_carrier, error) => {
      console.error('[slackThreadFooter] Failed to remove prior footer', error);
    },
  });
}

/**
 * Post a Slack thread message carrying the given footer text as the thread's
 * sticky footer: attach the footer block, remove the footer from the prior
 * tracked message, and persist the new location.
 */
export async function postSlackThreadMessageWithFooterText(params: {
  slack: Pick<
    SlackNotifier,
    'postMessage' | 'getMessageBlocks' | 'updateMessage'
  > &
    Partial<Pick<SlackNotifier, 'getWorkspaceId'>>;
  channel: string;
  threadTs: string;
  text: string;
  /** Body blocks without the footer context block. */
  bodyBlocks: unknown[];
  footerText: string;
  clientMsgId?: string;
}): Promise<string | null> {
  const footerBlock = buildSlackThreadReplyFooterBlock({
    footerText: params.footerText,
  });
  const bodyBlocks = params.bodyBlocks;

  return relocateSlackThreadFooter({
    ...params,
    publish: async () => {
      const messageId = await params.slack.postMessage({
        channel: params.channel,
        thread_ts: params.threadTs,
        text: params.text,
        unfurl_links: false,
        unfurl_media: false,
        blocks: [...bodyBlocks, footerBlock],
        ...(params.clientMsgId ? { client_msg_id: params.clientMsgId } : {}),
      });
      return messageId ? { messageId, result: messageId } : null;
    },
  });
}

/**
 * Rewrites an existing thread message (for example one that was streamed)
 * into its final body and makes it the sticky footer carrier, the same way a
 * freshly posted reply would be.
 */
export async function updateSlackThreadMessageWithFooterText(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'> &
    Partial<Pick<SlackNotifier, 'getWorkspaceId'>>;
  channel: string;
  threadTs: string;
  messageTs: string;
  text: string;
  /** Body blocks without the footer context block. */
  bodyBlocks: unknown[];
  footerText: string;
}): Promise<boolean> {
  const footerBlock = buildSlackThreadReplyFooterBlock({
    footerText: params.footerText,
  });

  const result = await relocateSlackThreadFooter({
    ...params,
    publish: async () => {
      const updated = await params.slack.updateMessage({
        channel: params.channel,
        ts: params.messageTs,
        message: {
          text: params.text,
          blocks: [...params.bodyBlocks, footerBlock],
        },
      });
      return updated
        ? { messageId: params.messageTs, result: true as const }
        : null;
    },
  });
  return result ?? false;
}

/**
 * Posts a Slack thread reply that becomes the sticky navigation footer
 * message for the thread: attaches the current footer, then removes it from
 * whatever prior reply still carries the tracked footer.
 *
 * Used by out-of-band posts (PR review updates, PR terminal status) so the
 * footer rides on the latest thread message the same way MCP thread replies do.
 */
export async function postSlackThreadMessageWithStickyFooter(params: {
  slack: Pick<
    SlackNotifier,
    'postMessage' | 'getMessageBlocks' | 'updateMessage'
  >;
  channel: string;
  threadTs: string;
  taskId: string;
  text: string;
  /** Body blocks without the footer context block. */
  blocks?: unknown[];
  utmCampaign?: string;
  /**
   * `reply-only` omits PR links for terminal PR events. Task status and any
   * available preview remain independent of the PR lifecycle.
   */
  footerStyle?: 'active' | 'reply-only';
}): Promise<string | null> {
  const taskUrl = buildOutOfBandTaskUrl(
    params.taskId,
    params.utmCampaign ?? 'slack.out_of_band',
  );
  const footerContext = await resolveSlackThreadFooterContext({
    taskId: params.taskId,
    prRepo: null,
    prNumber: null,
    channelId: params.channel,
    threadTs: params.threadTs,
  });
  const replyOnly = params.footerStyle === 'reply-only';
  const footerText = buildSlackThreadFooterText({
    ...footerContext,
    taskUrl,
    linkedPrs: replyOnly ? [] : footerContext.linkedPrs,
  });
  const bodyBlocks =
    params.blocks && params.blocks.length > 0
      ? params.blocks
      : [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: params.text,
            },
          },
        ];

  return postSlackThreadMessageWithFooterText({
    slack: params.slack,
    channel: params.channel,
    threadTs: params.threadTs,
    text: params.text,
    bodyBlocks,
    footerText,
  });
}

export async function rememberSlackThreadFooterRefresh(
  params: {
    slack: Partial<Pick<SlackNotifier, 'getWorkspaceId'>>;
    channel: string;
    threadTs: string;
  },
  assertLock: () => Promise<void>,
): Promise<void> {
  // Registration is best effort, separate from successful carrier persistence.
  try {
    const teamId = await params.slack.getWorkspaceId?.();
    if (!teamId) return;
    await assertLock();
    await getRedis().set(
      `slack:thread_footer_workspace:${params.channel}:${params.threadTs}`,
      teamId,
      'EX',
      30 * 24 * 60 * 60,
    );
    await assertLock();
    await scheduleThreadFooterRefresh({
      provider: 'slack',
      channelId: params.channel,
      threadId: params.threadTs,
    });
  } catch (error) {
    console.warn(
      '[slackThreadFooter] Failed to schedule footer refresh',
      error,
    );
  }
}

/**
 * Unregister a Slack destination, but only if its pointer still matches what
 * this refresh pass read: a delivery that raced in owns the registration now.
 */
/**
 * Bring the current carrier's footer block up to date. Resolution happens
 * outside the destination lock; the blocks are re-read under the lock before
 * editing so an in-place body update cannot be overwritten.
 */
export async function refreshSlackThreadReplyFooter(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'>;
  channel: string;
  threadTs: string;
}): Promise<ThreadFooterRefreshOutcome> {
  const read = async () => {
    const messageId = await getSlackThreadReplyFooterMessageTs(
      params.channel,
      params.threadTs,
    );
    return messageId ? { messageId } : null;
  };
  return refreshThreadFooterCarrier({
    lockKey: `${SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX}${params.channel}:${params.threadTs}`,
    read,
    sameVersion: (current, seen) => current?.messageId === seen?.messageId,
    forget: () =>
      forgetThreadFooterRefresh({
        provider: 'slack',
        channelId: params.channel,
        threadId: params.threadTs,
      }),
    resolve: async (carrier) => {
      const blocks = await params.slack.getMessageBlocks({
        channel: params.channel,
        threadTs: params.threadTs,
        messageTs: carrier.messageId,
        throwOnUnavailable: true,
      });
      if (!blocks) return null;
      const posted = readSlackThreadReplyFooter(blocks);
      if (!posted) return null;
      const previous = posted.text;
      const current = await resolveCurrentThreadFooter('slack', previous);
      if (!current) {
        console.warn(
          '[slackThreadFooter] Retiring a footer that no longer resolves',
          { channel: params.channel, threadTs: params.threadTs },
        );
        return null;
      }
      return {
        outcome: current.active ? 'active' : 'idle',
        settled: current.settled,
        changed: current.text !== previous,
        edit: async (latest) => {
          const latestBlocks = await params.slack.getMessageBlocks({
            channel: params.channel,
            threadTs: params.threadTs,
            messageTs: latest.messageId,
            throwOnUnavailable: true,
          });
          if (!latestBlocks) return false;
          const latestFooter = readSlackThreadReplyFooter(latestBlocks);
          if (!latestFooter || latestFooter.text !== previous) return false;
          const updatedBlocks = [...latestBlocks];
          updatedBlocks[latestFooter.index] = buildSlackThreadReplyFooterBlock({
            footerText: current.text,
          });
          if (
            !(await params.slack.updateMessage({
              channel: params.channel,
              ts: latest.messageId,
              message: { blocks: updatedBlocks },
            }))
          ) {
            throw new Error('Slack footer edit failed');
          }
          return true;
        },
        recoverAfterLostLease: async (latest) => {
          if ((await read())?.messageId !== latest.messageId) {
            await removeSlackThreadReplyFooter({
              slack: params.slack,
              channel: params.channel,
              threadTs: params.threadTs,
              messageTs: latest.messageId,
            }).catch(() => {});
          }
        },
      };
    },
    isGoneError: () => false,
  });
}
