import type {
  CommunicationPostMessageInput,
  CommunicationPostMessageResult,
} from './provider';
import type { TeamsCommunicationProvider } from './teams-provider';
import type { TelegramCommunicationProvider } from './telegram-provider';
import { chunkTelegramMarkdownAsHtml } from './telegram-format';
import {
  deliverManagedThreadReplyFooter,
  withThreadReplyFooterLock,
  rememberThreadReplyFooterAfterEdit,
} from './thread-reply-footer-delivery';
import {
  getThreadReplyFooterRecord,
  type ThreadReplyFooterRecord,
} from './thread-reply-footer-state';
import { resolveCurrentThreadFooterText } from './thread-footer-refresh';

type TextProvider = TeamsCommunicationProvider | TelegramCommunicationProvider;

export async function editTextThreadFooterMessage(
  provider: TextProvider,
  record: ThreadReplyFooterRecord,
  text: string,
): Promise<void> {
  if (!record.refresh) return;
  const input = {
    channelId: record.refresh.channelId,
    messageId: record.messageId,
    text: text || '\u200b',
    textFormat: 'markdown' as const,
  };
  if (provider.provider === 'teams') {
    await provider.updateMessage({
      ...input,
      serviceUrl: record.refresh.serviceUrl,
      images: record.images,
    });
  } else {
    const suffix = `\n\n`;
    const hasFooter =
      text !== record.textWithoutFooter &&
      (record.textWithoutFooter === '' ||
        text.startsWith(`${record.textWithoutFooter}${suffix}`));
    await provider.editMessageText({
      ...input,
      text: hasFooter ? record.textWithoutFooter || '\u200b' : text,
      ...(hasFooter
        ? {
            footerText: text.slice(
              record.textWithoutFooter.length +
                (record.textWithoutFooter ? suffix.length : 0),
            ),
          }
        : {}),
      ...(record.buttons ? { buttons: record.buttons } : {}),
    });
  }
}

/** Managed text-provider delivery, including replacing a known automation root. */
export async function postTextThreadReplyWithFooter(params: {
  provider: TextProvider;
  input: CommunicationPostMessageInput;
  footerText: string;
  messageId?: string;
}): Promise<CommunicationPostMessageResult> {
  const { provider, input } = params;
  const threadId = input.threadId ?? 'root';
  return deliverManagedThreadReplyFooter({
    provider: provider.provider,
    providerLabel: provider.provider,
    channelId: input.channelId,
    footerStateThreadId: threadId,
    lockKey: `${provider.provider}:thread_reply_footer_lock:${input.channelId}:${threadId}`,
    logRef: 'text reply',
    logContext: 'threadFooter',
    postReplyWithFooter: async () => {
      // The caller's footer already reflects the event that produced this
      // reply; the scheduled refresh keeps it current from here.
      const footerText = params.footerText;
      const text = [input.text, footerText].filter(Boolean).join('\n\n');
      const refresh = {
        footerText,
        channelId: input.channelId,
        ...(input.serviceUrl ? { serviceUrl: input.serviceUrl } : {}),
      };
      let posted: CommunicationPostMessageResult;
      if (params.messageId) {
        await editTextThreadFooterMessage(
          provider,
          {
            messageId: params.messageId,
            textWithoutFooter: input.text ?? '',
            images: input.images,
            refresh,
          },
          text,
        );
        posted = {
          provider: provider.provider,
          channelId: input.channelId,
          messageId: params.messageId,
        };
      } else {
        posted = await provider.postMessage({
          ...input,
          text: provider.provider === 'telegram' ? input.text : text,
          ...(provider.provider === 'telegram' ? { footerText } : {}),
          textFormat: 'markdown',
        });
      }
      const finalChunk =
        provider.provider === 'telegram'
          ? (chunkTelegramMarkdownAsHtml(text).at(-1)?.markdown ?? '')
          : text;
      const textWithoutFooter =
        finalChunk === footerText
          ? ''
          : finalChunk.endsWith(`\n\n${footerText}`)
            ? finalChunk.slice(0, -footerText.length - 2)
            : finalChunk;
      return {
        ...posted,
        messageId: posted.lastTextMessageId ?? posted.messageId,
        textWithoutFooter,
        ...(provider.provider === 'telegram' &&
        !input.images?.length &&
        input.buttons
          ? { buttons: input.buttons }
          : {}),
        ...(provider.provider === 'teams' && input.images?.length
          ? { images: input.images }
          : {}),
        ...(finalChunk.endsWith(footerText) ? { refresh } : {}),
      };
    },
    clearPreviousFooter: (record) =>
      editTextThreadFooterMessage(
        provider,
        {
          ...record,
          refresh: record.refresh ?? {
            footerText: '',
            channelId: input.channelId,
            serviceUrl: input.serviceUrl,
          },
        },
        record.textWithoutFooter,
      ),
  });
}

export async function replaceTextThreadReplyWithFooter(params: {
  provider: TextProvider;
  channelId: string;
  threadId?: string;
  serviceUrl?: string;
  messageId: string;
  text: string;
}): Promise<void> {
  const threadId = params.threadId ?? 'root';
  await withThreadReplyFooterLock({
    lockKey: `${params.provider.provider}:thread_reply_footer_lock:${params.channelId}:${threadId}`,
    fn: async (assertLock, lock) => {
      const record = await getThreadReplyFooterRecord(
        params.provider.provider,
        params.channelId,
        threadId,
      );
      const current = record?.messageId === params.messageId ? record : null;
      const footerText = current?.refresh
        ? ((await resolveCurrentThreadFooterText(
            params.provider.provider,
            current.refresh.footerText,
          )) ?? current.refresh.footerText)
        : '';
      const next = {
        ...(current ?? {}),
        messageId: params.messageId,
        textWithoutFooter: params.text,
        refresh: {
          footerText,
          channelId: params.channelId,
          serviceUrl: params.serviceUrl,
        },
      };
      await assertLock();
      await editTextThreadFooterMessage(
        params.provider,
        next,
        [params.text, footerText].filter(Boolean).join('\n\n'),
      );
      if (current)
        await rememberThreadReplyFooterAfterEdit({
          provider: params.provider.provider,
          channelId: params.channelId,
          threadId,
          record: next,
          assertLock,
          lock,
          clearOwnFooter: () =>
            editTextThreadFooterMessage(params.provider, next, params.text),
        });
    },
  });
}
