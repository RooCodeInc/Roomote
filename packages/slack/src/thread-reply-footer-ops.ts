import crypto from 'node:crypto';

import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';

import type { SlackNotifier } from './slack-notifier';
import {
  getSlackThreadReplyFooterMessageTs,
  setSlackThreadReplyFooterMessageTs,
} from './slack-messages';
import {
  buildSlackThreadFooterText,
  resolveSlackThreadFooterContext,
} from './thread-footer';
import {
  buildSlackThreadActiveTaskBlocks,
  getSlackThreadActiveTasks,
  isSlackThreadActiveTaskBlock,
} from './thread-active-tasks';

export const SLACK_THREAD_REPLY_FOOTER_BLOCK_ID = 'roomote_thread_reply_footer';

const SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX = 'slack:thread_reply_footer_lock:';
const THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS = 30;
const THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS = 8;
const THREAD_REPLY_FOOTER_LOCK_RETRY_MS = 100;
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

export const THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE =
  'Timed out acquiring thread reply footer lock';

function isSlackThreadReplyFooterText(text: string): boolean {
  return /^_(?:Reply(?: with @-mention)? or use the <[^>]+\|web app>\.|Working on (?:<[^>]+\|PR(?:\s+#)?\d+>(?:, <[^>]+\|live preview>)?|a <[^>]+\|live preview>), reply(?: with @-mention)? or use the <[^>]+\|web app>\.)_$/.test(
    text,
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

function removeSlackThreadStickyBlocks(blocks: unknown[]): unknown[] {
  return blocks.filter(
    (block) =>
      !isSlackThreadReplyFooterBlock(block) &&
      !isSlackThreadActiveTaskBlock(block),
  );
}

async function buildSlackThreadStickyBlocks(params: {
  channel: string;
  threadTs: string;
  footerBlock: unknown;
  includeActiveTasks: boolean;
}): Promise<unknown[]> {
  if (!params.includeActiveTasks) return [params.footerBlock];
  try {
    const tasks = await getSlackThreadActiveTasks(params);
    return [...buildSlackThreadActiveTaskBlocks(tasks), params.footerBlock];
  } catch (error) {
    console.warn(
      `[slackThreadFooter] Failed to load active tasks for thread ${params.threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [params.footerBlock];
  }
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

export async function withSlackThreadReplyFooterLock<T>(params: {
  channel: string;
  threadTs: string;
  maxAcquireAttempts?: number;
  fn: () => Promise<T>;
}): Promise<T> {
  const redis = getRedis();
  const lockKey = `${SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX}${params.channel}:${params.threadTs}`;
  const maxAcquireAttempts =
    params.maxAcquireAttempts ?? THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    const ownerId = crypto.randomUUID();
    const acquired = await redis.set(
      lockKey,
      ownerId,
      'EX',
      THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS,
      'NX',
    );

    if (acquired) {
      try {
        return await params.fn();
      } finally {
        await redis
          .eval(RELEASE_LOCK_SCRIPT, 1, lockKey, ownerId)
          .catch(() => {});
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, THREAD_REPLY_FOOTER_LOCK_RETRY_MS),
    );
  }

  throw new Error(THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE);
}

export async function removeSlackThreadReplyFooter(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'>;
  channel: string;
  threadTs: string;
  messageTs: string;
}): Promise<void> {
  const blocks = await params.slack.getMessageBlocks({
    channel: params.channel,
    messageTs: params.messageTs,
    threadTs: params.threadTs,
  });

  if (!blocks) {
    return;
  }

  const updatedBlocks = removeSlackThreadStickyBlocks(blocks);

  if (updatedBlocks.length === blocks.length) {
    return;
  }

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

/**
 * Post a Slack thread message carrying the given footer text as the thread's
 * sticky footer: attach the footer block, remove the footer from the prior
 * tracked message, and persist the new location.
 */
export async function postSlackThreadMessageWithFooterText(params: {
  slack: Pick<
    SlackNotifier,
    'postMessage' | 'getMessageBlocks' | 'updateMessage'
  >;
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

  return withSlackThreadReplyFooterLock({
    channel: params.channel,
    threadTs: params.threadTs,
    fn: async () => {
      const previousFooterMessageTs = await getSlackThreadReplyFooterMessageTs(
        params.channel,
        params.threadTs,
      );
      const stickyBlocks = await buildSlackThreadStickyBlocks({
        channel: params.channel,
        threadTs: params.threadTs,
        footerBlock,
        includeActiveTasks: bodyBlocks.length <= 48,
      });

      const nextMessageTs = await params.slack.postMessage({
        channel: params.channel,
        thread_ts: params.threadTs,
        text: params.text,
        unfurl_links: false,
        unfurl_media: false,
        blocks: [...bodyBlocks, ...stickyBlocks],
        ...(params.clientMsgId ? { client_msg_id: params.clientMsgId } : {}),
      });

      if (!nextMessageTs) {
        return null;
      }

      if (
        previousFooterMessageTs &&
        previousFooterMessageTs !== nextMessageTs
      ) {
        try {
          await removeSlackThreadReplyFooter({
            slack: params.slack,
            channel: params.channel,
            threadTs: params.threadTs,
            messageTs: previousFooterMessageTs,
          });
        } catch (error) {
          console.error(
            `[slackThreadFooter] Failed to remove footer from prior Slack message ${previousFooterMessageTs}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      try {
        await setSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
          nextMessageTs,
        );
      } catch (error) {
        console.error(
          `[slackThreadFooter] Failed to persist latest footer message ts ${nextMessageTs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        try {
          await removeSlackThreadReplyFooter({
            slack: params.slack,
            channel: params.channel,
            threadTs: params.threadTs,
            messageTs: nextMessageTs,
          });
        } catch (removeError) {
          console.error(
            `[slackThreadFooter] Failed to remove footer from latest Slack message ${nextMessageTs} after persistence failure: ${
              removeError instanceof Error
                ? removeError.message
                : String(removeError)
            }`,
          );
        }
      }

      return nextMessageTs;
    },
  });
}

/**
 * Rewrites an existing thread message (for example one that was streamed)
 * into its final body and makes it the sticky footer carrier, the same way a
 * freshly posted reply would be.
 */
export async function updateSlackThreadMessageWithFooterText(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'>;
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

  return withSlackThreadReplyFooterLock({
    channel: params.channel,
    threadTs: params.threadTs,
    fn: async () => {
      const previousFooterMessageTs = await getSlackThreadReplyFooterMessageTs(
        params.channel,
        params.threadTs,
      );
      const stickyBlocks = await buildSlackThreadStickyBlocks({
        channel: params.channel,
        threadTs: params.threadTs,
        footerBlock,
        includeActiveTasks: params.bodyBlocks.length <= 48,
      });
      const updated = await params.slack.updateMessage({
        channel: params.channel,
        ts: params.messageTs,
        message: {
          text: params.text,
          blocks: [...params.bodyBlocks, ...stickyBlocks],
        },
      });
      if (!updated) {
        return false;
      }

      if (
        previousFooterMessageTs &&
        previousFooterMessageTs !== params.messageTs
      ) {
        try {
          await removeSlackThreadReplyFooter({
            slack: params.slack,
            channel: params.channel,
            threadTs: params.threadTs,
            messageTs: previousFooterMessageTs,
          });
        } catch (error) {
          console.error(
            `[slackThreadFooter] Failed to remove footer from prior Slack message ${previousFooterMessageTs}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      try {
        await setSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
          params.messageTs,
        );
      } catch (error) {
        console.error(
          `[slackThreadFooter] Failed to persist latest footer message ts ${params.messageTs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Without the pointer no later reply could strip this footer, so
        // take it back off rather than let the thread collect duplicates.
        try {
          await removeSlackThreadReplyFooter({
            slack: params.slack,
            channel: params.channel,
            threadTs: params.threadTs,
            messageTs: params.messageTs,
          });
        } catch (removeError) {
          console.error(
            `[slackThreadFooter] Failed to remove footer from Slack message ${params.messageTs} after persistence failure: ${
              removeError instanceof Error
                ? removeError.message
                : String(removeError)
            }`,
          );
        }
      }

      return true;
    },
  });
}

/** Rebuild the tracked footer carrier after a task summary changes status. */
export async function refreshSlackThreadActiveTaskFooter(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'>;
  channel: string;
  threadTs: string;
}): Promise<void> {
  try {
    await withSlackThreadReplyFooterLock({
      channel: params.channel,
      threadTs: params.threadTs,
      fn: async () => {
        const messageTs = await getSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
        );
        if (!messageTs) return;

        const blocks = await params.slack.getMessageBlocks({
          channel: params.channel,
          threadTs: params.threadTs,
          messageTs,
        });
        if (!blocks) return;

        const footerBlock = blocks.find(isSlackThreadReplyFooterBlock);
        if (!footerBlock) return;
        const bodyBlocks = removeSlackThreadStickyBlocks(blocks);

        const stickyBlocks = await buildSlackThreadStickyBlocks({
          channel: params.channel,
          threadTs: params.threadTs,
          footerBlock,
          includeActiveTasks: bodyBlocks.length <= 48,
        });
        await params.slack.updateMessage({
          channel: params.channel,
          ts: messageTs,
          message: {
            blocks: [...bodyBlocks, ...stickyBlocks],
          },
        });
      },
    });
  } catch (error) {
    console.warn(
      `[slackThreadFooter] Failed to refresh task summaries in thread ${params.threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Posts a Slack thread reply that becomes the sticky "Working on..." footer
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
   * Footer content style. `active` keeps linked PR / live preview when the
   * shared resolver still considers the task active. `reply-only` is for
   * terminal events (merged/closed PRs) so the relocated sticky line never
   * reads as "still working on this" after the task becomes terminal.
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
    taskUrl,
    linkedPrs: replyOnly ? [] : footerContext.linkedPrs,
    livePreviewUrl: replyOnly ? null : footerContext.livePreviewUrl,
    explicitMentionRequired: footerContext.explicitMentionRequired,
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
