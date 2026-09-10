import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';
import {
  tryThreadReplyFooterLock,
  withThreadReplyFooterLock,
} from '@roomote/communication/thread-reply-footer-delivery';
import {
  scheduleThreadFooterRefresh,
  forgetThreadFooterRefresh,
  resolveCurrentThreadFooter,
  type ThreadFooterRefreshOutcome,
} from '@roomote/communication';

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

  return withSlackThreadReplyFooterLock({
    channel: params.channel,
    threadTs: params.threadTs,
    fn: async (assertLock) => {
      const previousFooterMessageTs = await getSlackThreadReplyFooterMessageTs(
        params.channel,
        params.threadTs,
      );

      await assertLock();
      const nextMessageTs = await params.slack.postMessage({
        channel: params.channel,
        thread_ts: params.threadTs,
        text: params.text,
        unfurl_links: false,
        unfurl_media: false,
        blocks: [...bodyBlocks, footerBlock],
        ...(params.clientMsgId ? { client_msg_id: params.clientMsgId } : {}),
      });

      if (!nextMessageTs) {
        return null;
      }

      try {
        await assertLock();
        await setSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
          nextMessageTs,
        );
        await rememberSlackThreadFooterRefresh(params, assertLock);
      } catch (error) {
        console.error(
          `[slackThreadFooter] Failed to persist latest footer message ts ${nextMessageTs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        const current = await getSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
        ).catch(() => undefined);
        if (current === undefined || current === nextMessageTs)
          return nextMessageTs;
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
        return nextMessageTs;
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
            assertLock,
          });
        } catch (error) {
          console.error(
            '[slackThreadFooter] Failed to remove prior footer',
            error,
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

  return withSlackThreadReplyFooterLock({
    channel: params.channel,
    threadTs: params.threadTs,
    fn: async (assertLock) => {
      const previousFooterMessageTs = await getSlackThreadReplyFooterMessageTs(
        params.channel,
        params.threadTs,
      );
      await assertLock();
      const updated = await params.slack.updateMessage({
        channel: params.channel,
        ts: params.messageTs,
        message: {
          text: params.text,
          blocks: [...params.bodyBlocks, footerBlock],
        },
      });
      if (!updated) {
        return false;
      }

      try {
        await assertLock();
        await setSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
          params.messageTs,
        );
        await rememberSlackThreadFooterRefresh(params, assertLock);
      } catch (error) {
        console.error(
          `[slackThreadFooter] Failed to persist latest footer message ts ${params.messageTs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        const current = await getSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
        ).catch(() => undefined);
        if (current === undefined || current === params.messageTs) return true;
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
        return true;
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
            assertLock,
          });
        } catch (error) {
          console.error(
            '[slackThreadFooter] Failed to remove prior footer',
            error,
          );
        }
      }

      return true;
    },
  });
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
async function forgetSlackFooterIfUnchanged(params: {
  channel: string;
  threadTs: string;
  seenMessageTs: string | null;
}): Promise<ThreadFooterRefreshOutcome> {
  const result = await tryThreadReplyFooterLock({
    lockKey: `${SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX}${params.channel}:${params.threadTs}`,
    fn: async (assertLock): Promise<ThreadFooterRefreshOutcome> => {
      const current = await getSlackThreadReplyFooterMessageTs(
        params.channel,
        params.threadTs,
      );
      if ((current ?? null) !== params.seenMessageTs) return 'active';
      await assertLock();
      await forgetThreadFooterRefresh({
        provider: 'slack',
        channelId: params.channel,
        threadId: params.threadTs,
      });
      return 'gone';
    },
  });
  return result.acquired ? result.value : 'active';
}

/**
 * Bring the current carrier's footer block up to date. Reading the message
 * and resolving state happen outside the destination lock; the lock is held
 * only for the edit, so a concurrent reply is never starved by Slack reads.
 */
export async function refreshSlackThreadReplyFooter(params: {
  slack: Pick<SlackNotifier, 'getMessageBlocks' | 'updateMessage'>;
  channel: string;
  threadTs: string;
}): Promise<ThreadFooterRefreshOutcome> {
  const messageTs = await getSlackThreadReplyFooterMessageTs(
    params.channel,
    params.threadTs,
  );
  if (!messageTs)
    return forgetSlackFooterIfUnchanged({ ...params, seenMessageTs: null });
  const blocks = await params.slack.getMessageBlocks({
    channel: params.channel,
    threadTs: params.threadTs,
    messageTs,
    throwOnUnavailable: true,
  });
  const index = blocks?.findIndex(isSlackThreadReplyFooterBlock) ?? -1;
  if (!blocks || index < 0)
    return forgetSlackFooterIfUnchanged({
      ...params,
      seenMessageTs: messageTs,
    });
  const block = blocks[index] as {
    text?: string;
    elements?: { text?: string }[];
  };
  const posted =
    block.elements?.find((element) => typeof element.text === 'string')?.text ??
    block.text;
  if (!posted)
    return forgetSlackFooterIfUnchanged({
      ...params,
      seenMessageTs: messageTs,
    });
  // Slack returns block text with `&`, `<` and `>` escaped; compare and
  // resolve against the text as it was written.
  const previous = decodeSlackEntity(posted);
  const current = await resolveCurrentThreadFooter('slack', previous);
  if (!current) {
    console.warn(
      '[slackThreadFooter] Retiring a footer that no longer resolves',
      { channel: params.channel, threadTs: params.threadTs },
    );
    return forgetSlackFooterIfUnchanged({
      ...params,
      seenMessageTs: messageTs,
    });
  }
  const outcome: ThreadFooterRefreshOutcome = current.active
    ? 'active'
    : 'idle';
  if (current.text === previous) {
    return current.settled
      ? forgetSlackFooterIfUnchanged({ ...params, seenMessageTs: messageTs })
      : outcome;
  }
  const result = await tryThreadReplyFooterLock({
    lockKey: `${SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX}${params.channel}:${params.threadTs}`,
    fn: async (assertLock): Promise<ThreadFooterRefreshOutcome> => {
      // A reply relocated the footer while this pass was resolving; the next
      // pass reads the new carrier.
      if (
        (await getSlackThreadReplyFooterMessageTs(
          params.channel,
          params.threadTs,
        )) !== messageTs
      )
        return 'active';
      await assertLock();
      const updatedBlocks = [...blocks];
      updatedBlocks[index] = buildSlackThreadReplyFooterBlock({
        footerText: current.text,
      });
      // updateMessage verifies ownership and preserves fallback text/attachments.
      await params.slack.updateMessage({
        channel: params.channel,
        ts: messageTs,
        message: { blocks: updatedBlocks },
      });
      if (current.settled) {
        await assertLock();
        await forgetThreadFooterRefresh({
          provider: 'slack',
          channelId: params.channel,
          threadId: params.threadTs,
        });
        return 'gone';
      }
      return outcome;
    },
  });
  // A delivery holds the lock: it re-registers the destination itself.
  return result.acquired ? result.value : 'active';
}
