import type {
  FastAgentConversation,
  FastAgentReplyHandle,
  FastAgentTurnAdapter,
} from '@roomote/cloud-agents/server';
import {
  buildFastSessionReplyFooterText,
  getThreadReplyFooterRecord,
  rememberThreadReplyFooterAfterEdit,
  withThreadReplyFooterLock,
  replaceTextThreadReplyWithFooter,
  type FastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  DISCORD_MAX_MESSAGE_LENGTH,
  type DiscordCommunicationProvider,
} from '@roomote/communication/discord-provider';
import type { TeamsCommunicationProvider } from '@roomote/communication/teams-provider';
import type { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import {
  buildSlackThreadReplyFooterBlock,
  getSlackThreadReplyFooterMessageTs,
  withSlackThreadReplyFooterLock,
  removeSlackThreadReplyFooter,
  type SlackNotifier,
} from '@roomote/slack';

import { recordFastAgentConversationMessageBestEffort } from './fast-agent-provider-message';

/**
 * Edit-in-place reply replacement per surface. A Fast turn edits its own
 * retry notice into the eventual answer, and a turn the durable queue
 * resumes on another process inherits that notice, so every adapter that
 * can run a resumed turn needs the same replacement behavior as the
 * webhook handler that posted the notice.
 */
type FastAgentReplyReplacer = NonNullable<FastAgentTurnAdapter['replaceReply']>;

export function createSlackFastReplyReplacer(params: {
  slack: SlackNotifier;
  conversation: FastAgentConversation;
  channelId: string;
  threadTs: string;
  sessionId: string;
  footerContext: FastSessionReplyFooterContext;
}): FastAgentReplyReplacer {
  return async (handle, { message }) => {
    // Keep the sticky footer when the edited message is its current
    // carrier; the lookup and edit share the footer lock so a concurrent
    // relocation cannot slip in between them.
    const updated = await withSlackThreadReplyFooterLock({
      channel: params.channelId,
      threadTs: params.threadTs,
      fn: async (assertLock) => {
        const footerMessageTs = await getSlackThreadReplyFooterMessageTs(
          params.channelId,
          params.threadTs,
        ).catch(() => null);
        await assertLock();
        const updated = await params.slack.updateMessage({
          channel: params.channelId,
          ts: handle.messageId,
          message: {
            text: message,
            blocks: [
              { type: 'markdown', text: message },
              ...(footerMessageTs === handle.messageId
                ? [
                    buildSlackThreadReplyFooterBlock({
                      footerText: buildFastSessionReplyFooterText({
                        provider: 'slack',
                        sessionId: params.sessionId,
                        ...params.footerContext,
                      }),
                    }),
                  ]
                : []),
            ],
          },
        });
        try {
          await assertLock();
        } catch {
          const current = await getSlackThreadReplyFooterMessageTs(
            params.channelId,
            params.threadTs,
          ).catch(() => undefined);
          if (current !== undefined && current !== handle.messageId)
            await removeSlackThreadReplyFooter({
              slack: params.slack,
              channel: params.channelId,
              threadTs: params.threadTs,
              messageTs: handle.messageId,
            }).catch(() => {});
        }
        return updated;
      },
    });
    if (!updated) {
      throw new Error('Slack did not update the Fast reply.');
    }
    await recordFastAgentConversationMessageBestEffort({
      sessionId: params.sessionId,
      conversation: params.conversation,
      messageId: handle.messageId,
    });
    return handle;
  };
}

export function createDiscordFastReplyReplacer(params: {
  provider: DiscordCommunicationProvider;
  conversation: FastAgentConversation;
  channelId: string;
  threadId: string | undefined;
  sessionId: string;
  footerContext: FastSessionReplyFooterContext;
  /** Posts the replacement as a new message when it does not fit an edit. */
  postReplacement: (text: string) => Promise<FastAgentReplyHandle | void>;
}): FastAgentReplyReplacer {
  return async ({ messageId }, { message: text }) => {
    const footerText = buildFastSessionReplyFooterText({
      provider: 'discord',
      sessionId: params.sessionId,
      ...params.footerContext,
    });
    const footerStateThreadId = params.threadId ?? 'root';
    const editChannelId = params.threadId ?? params.channelId;

    // The carrier check, edit, and record write must share the footer lock,
    // or a concurrent reply can relocate the footer in between and this
    // replacement would re-mark the old message as carrier.
    const replaced = await withThreadReplyFooterLock({
      lockKey: `discord:thread_reply_footer_lock:${params.channelId}:${footerStateThreadId}`,
      fn: async (assertLock, lock) => {
        const footerRecord = await getThreadReplyFooterRecord(
          'discord',
          params.channelId,
          footerStateThreadId,
        ).catch(() => null);
        const isFooterCarrier = footerRecord?.messageId === messageId;
        const replacementText = isFooterCarrier
          ? `${text}\n\n${footerText}`
          : text;
        await assertLock();

        if (replacementText.length > DISCORD_MAX_MESSAGE_LENGTH) {
          const placeholder = 'Reconnected to the inference provider.';
          await params.provider.editMessage({
            channelId: editChannelId,
            messageId,
            text: isFooterCarrier
              ? `${placeholder}\n\n${footerText}`
              : placeholder,
          });
          if (isFooterCarrier) {
            // The relocation that follows rewrites this message to its
            // stored footerless text; keep that text current so the edit
            // does not resurrect the pre-retry notice.
            await rememberThreadReplyFooterAfterEdit({
              provider: 'discord',
              channelId: params.channelId,
              threadId: footerStateThreadId,
              assertLock,
              lock,
              record: {
                ...footerRecord,
                messageId,
                textWithoutFooter: placeholder,
                refresh: { footerText, channelId: editChannelId },
              },
              clearOwnFooter: () =>
                params.provider.editMessage({
                  channelId: editChannelId,
                  messageId,
                  text: placeholder,
                  preserveButtons: true,
                }),
            }).catch(() => {});
          }
          return false;
        }

        await params.provider.editMessage({
          channelId: editChannelId,
          messageId,
          text: replacementText,
        });
        if (isFooterCarrier) {
          await rememberThreadReplyFooterAfterEdit({
            provider: 'discord',
            channelId: params.channelId,
            threadId: footerStateThreadId,
            assertLock,
            lock,
            record: {
              ...footerRecord,
              messageId,
              textWithoutFooter: text,
              refresh: { footerText, channelId: editChannelId },
            },
            clearOwnFooter: () =>
              params.provider.editMessage({
                channelId: editChannelId,
                messageId,
                text,
                preserveButtons: true,
              }),
          }).catch(() => {});
        }
        return true;
      },
    });

    if (!replaced) {
      // The oversized replacement posts as a new message; the sticky post
      // takes the footer lock itself, so it runs outside ours.
      const posted = await params.postReplacement(text);
      return posted ?? { messageId };
    }
    await recordFastAgentConversationMessageBestEffort({
      sessionId: params.sessionId,
      conversation: params.conversation,
      messageId,
    });
    return { messageId };
  };
}

export function createTeamsFastReplyReplacer(params: {
  provider: TeamsCommunicationProvider;
  conversation: FastAgentConversation;
  channelId: string;
  serviceUrl: string;
  sessionId: string;
  footerContext: FastSessionReplyFooterContext;
}): FastAgentReplyReplacer {
  return async (handle, { message }) => {
    await replaceTextThreadReplyWithFooter({
      provider: params.provider,
      channelId: params.channelId,
      threadId:
        'replyTarget' in params.conversation
          ? params.conversation.replyTarget.threadId
          : undefined,
      messageId: handle.messageId,
      serviceUrl: params.serviceUrl,
      text: message,
    });
    await recordFastAgentConversationMessageBestEffort({
      sessionId: params.sessionId,
      conversation: params.conversation,
      messageId: handle.messageId,
    });
    return handle;
  };
}

export function createTelegramFastReplyReplacer(params: {
  provider: TelegramCommunicationProvider;
  conversation: FastAgentConversation;
  channelId: string;
  sessionId: string;
  footerContext: FastSessionReplyFooterContext;
}): FastAgentReplyReplacer {
  return async (handle, { message }) => {
    await replaceTextThreadReplyWithFooter({
      provider: params.provider,
      channelId: params.channelId,
      threadId:
        'replyTarget' in params.conversation
          ? params.conversation.replyTarget.threadId
          : undefined,
      messageId: handle.messageId,
      text: message,
    });
    await recordFastAgentConversationMessageBestEffort({
      sessionId: params.sessionId,
      conversation: params.conversation,
      messageId: handle.messageId,
    });
    return handle;
  };
}
