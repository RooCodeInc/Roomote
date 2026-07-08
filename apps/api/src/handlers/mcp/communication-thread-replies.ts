import {
  TeamsCommunicationProvider,
  TelegramCommunicationProvider,
  UnsupportedCommunicationOperationError,
  getLatestInboundMessageId,
} from '@roomote/communication';
import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
} from '@roomote/types';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';

import { THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE } from './chat-reply-helpers';
import {
  buildCommunicationThreadReplyFooterTextBestEffort,
  deliverManagedThreadReplyFooter,
  getCommunicationReplyImages,
  type CommunicationReplyCloudJob,
  type ParsedThreadReplyBody,
} from './communication-thread-reply-shared';

const LOG_CONTEXT = 'communicationThreadReplies';
const TEAMS_THREAD_REPLY_FOOTER_LOCK_PREFIX = 'teams:thread_reply_footer_lock:';
const TELEGRAM_THREAD_REPLY_FOOTER_LOCK_PREFIX =
  'telegram:thread_reply_footer_lock:';

async function createTeamsCommunicationProvider(): Promise<TeamsCommunicationProvider | null> {
  return createTeamsCommunicationProviderFromRuntimeCredentials();
}

async function createTelegramCommunicationProvider(): Promise<TelegramCommunicationProvider | null> {
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return null;
  }

  return new TelegramCommunicationProvider({ botToken });
}

async function sendTeamsThreadReply(params: {
  cloudJob: CommunicationReplyCloudJob;
  parsedBody: ParsedThreadReplyBody;
}): Promise<Response> {
  const channelId = getCommunicationChannelFromTaskPayload(
    params.cloudJob.payload,
  );
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(
    params.cloudJob.payload,
  );
  const threadId = getCommunicationThreadIdFromTaskPayload(
    params.cloudJob.payload,
  );
  const messageId = getCommunicationMessageIdFromTaskPayload(
    params.cloudJob.payload,
  );

  if (!channelId || !serviceUrl) {
    return new Response(
      JSON.stringify({
        error:
          'Teams thread reply is only available for jobs with Teams conversation and serviceUrl context',
      }),
      { status: 403 },
    );
  }

  const provider = await createTeamsCommunicationProvider();
  if (!provider) {
    return new Response(
      JSON.stringify({
        error: 'Teams bot credentials are not configured for outbound replies',
      }),
      { status: 503 },
    );
  }

  const { images, errorResponse } = await getCommunicationReplyImages({
    cloudJob: { id: params.cloudJob.id, taskId: params.cloudJob.taskId },
    parsedBody: params.parsedBody,
  });
  if (errorResponse) {
    return errorResponse;
  }

  const text = params.parsedBody.text?.trim();
  if (!text && images.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'Teams thread replies require text or image attachments',
      }),
      { status: 400 },
    );
  }

  const footerText = await buildCommunicationThreadReplyFooterTextBestEffort({
    provider: 'teams',
    providerLabel: 'Teams',
    cloudJob: params.cloudJob,
    logContext: LOG_CONTEXT,
  });

  const postTeamsReply = async () =>
    provider.postMessage({
      channelId,
      serviceUrl,
      ...(threadId ? { threadId } : {}),
      replyToMessageId: threadId ?? messageId ?? undefined,
      ...(text || footerText
        ? {
            text: footerText
              ? [text, footerText].filter(Boolean).join('\n\n')
              : text!,
          }
        : {}),
      textFormat: 'markdown',
      images,
    });

  let reply: Awaited<ReturnType<typeof postTeamsReply>>;

  if (!footerText) {
    reply = await postTeamsReply();
  } else {
    const footerStateThreadId = threadId ?? 'root';

    try {
      reply = await deliverManagedThreadReplyFooter({
        provider: 'teams',
        providerLabel: 'Teams',
        channelId,
        footerStateThreadId,
        lockKey: `${TEAMS_THREAD_REPLY_FOOTER_LOCK_PREFIX}${channelId}:${footerStateThreadId}`,
        cloudJobId: params.cloudJob.id,
        logContext: LOG_CONTEXT,
        postReplyWithFooter: async () => ({
          ...(await postTeamsReply()),
          textWithoutFooter: text ?? '',
          ...(images.length > 0 ? { images } : {}),
        }),
        clearPreviousFooter: async (previousFooterRecord) => {
          await provider.updateMessage({
            channelId,
            serviceUrl,
            messageId: previousFooterRecord.messageId,
            text: previousFooterRecord.textWithoutFooter,
            textFormat: 'markdown',
            ...(previousFooterRecord.images &&
            previousFooterRecord.images.length > 0
              ? { images: previousFooterRecord.images }
              : {}),
          });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message === THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE) {
        return new Response(
          JSON.stringify({
            error: 'Teams thread reply is busy; please retry shortly',
          }),
          { status: 503 },
        );
      }

      throw error;
    }
  }

  return new Response(JSON.stringify({ messageTs: reply.messageId }), {
    headers: { 'content-type': 'application/json' },
  });
}

async function sendTelegramThreadReply(params: {
  cloudJob: CommunicationReplyCloudJob;
  parsedBody: ParsedThreadReplyBody;
}): Promise<Response> {
  const channelId = getCommunicationChannelFromTaskPayload(
    params.cloudJob.payload,
  );
  const threadId = getCommunicationThreadIdFromTaskPayload(
    params.cloudJob.payload,
  );
  const messageId = getCommunicationMessageIdFromTaskPayload(
    params.cloudJob.payload,
  );

  if (!channelId) {
    return new Response(
      JSON.stringify({
        error:
          'Telegram thread reply is only available for jobs with Telegram chat context',
      }),
      { status: 403 },
    );
  }

  const provider = await createTelegramCommunicationProvider();
  if (!provider) {
    return new Response(
      JSON.stringify({
        error: 'Telegram bot token is not configured for outbound replies',
      }),
      { status: 503 },
    );
  }

  const { images, errorResponse } = await getCommunicationReplyImages({
    cloudJob: { id: params.cloudJob.id, taskId: params.cloudJob.taskId },
    parsedBody: params.parsedBody,
  });
  if (errorResponse) {
    return errorResponse;
  }

  const text = params.parsedBody.text?.trim();
  if (!text && images.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'Telegram thread replies require text or image attachments',
      }),
      { status: 400 },
    );
  }

  // Prefer the most recent inbound user message id so the reply quotes the
  // latest user message rather than the original launch message. Falls back
  // to the launch communicationMessageId when no follow-up has arrived.
  let replyToMessageId = messageId;
  try {
    const latestInboundMessageId = await getLatestInboundMessageId(
      'telegram',
      params.cloudJob.id,
    );
    if (latestInboundMessageId) {
      replyToMessageId = latestInboundMessageId;
    }
  } catch (error) {
    console.error(
      `[${LOG_CONTEXT}] Failed to read latest inbound Telegram message id for cloud job ${params.cloudJob.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const reply = await provider.postMessage({
    channelId,
    ...(threadId ? { threadId } : {}),
    replyToMessageId: replyToMessageId ?? undefined,
    ...(text ? { text } : {}),
    textFormat: 'markdown',
    images,
  });

  await postTelegramThreadReplyFooterBestEffort({
    provider,
    cloudJob: params.cloudJob,
    channelId,
    threadId,
  });

  return new Response(JSON.stringify({ messageTs: reply.messageId }), {
    headers: { 'content-type': 'application/json' },
  });
}

async function addTelegramReaction(params: {
  cloudJob: { id: number; payload: unknown };
  parsedBody: { channel: string; messageTs: string; name: string };
}): Promise<Response> {
  const jobChannelId = getCommunicationChannelFromTaskPayload(
    params.cloudJob.payload,
  );
  const requestedChannelId = params.parsedBody.channel.replace(/^#/, '');

  if (!jobChannelId || requestedChannelId !== jobChannelId) {
    return new Response(
      JSON.stringify({
        error:
          'Telegram reactions are only available for the chat this task was launched from',
      }),
      { status: 403 },
    );
  }

  const provider = await createTelegramCommunicationProvider();
  if (!provider) {
    return new Response(
      JSON.stringify({
        error: 'Telegram bot token is not configured for reactions',
      }),
      { status: 503 },
    );
  }

  try {
    const result = await provider.addReaction({
      channelId: jobChannelId,
      messageId: params.parsedBody.messageTs,
      name: params.parsedBody.name,
    });

    return new Response(
      JSON.stringify({
        channelId: result.channelId,
        messageTs: result.messageId,
        name: result.name,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  } catch (error) {
    if (error instanceof UnsupportedCommunicationOperationError) {
      return new Response(
        JSON.stringify({
          error: [error.message, error.help].filter(Boolean).join(' '),
        }),
        { status: 400 },
      );
    }

    return new Response(
      JSON.stringify({
        error: `Telegram reaction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
      { status: 502 },
    );
  }
}

async function addTeamsReaction(params: {
  cloudJob: { id: number; payload: unknown };
  parsedBody: { channel: string; messageTs: string; name: string };
}): Promise<Response> {
  const jobChannelId = getCommunicationChannelFromTaskPayload(
    params.cloudJob.payload,
  );
  const requestedChannelId = params.parsedBody.channel.replace(/^#/, '');

  if (!jobChannelId || requestedChannelId !== jobChannelId) {
    return new Response(
      JSON.stringify({
        error:
          'Teams reactions are only available for the conversation this task was launched from',
      }),
      { status: 403 },
    );
  }

  const provider = await createTeamsCommunicationProvider();
  if (!provider) {
    return new Response(
      JSON.stringify({
        error: 'Teams bot credentials are not configured for reactions',
      }),
      { status: 503 },
    );
  }

  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(
    params.cloudJob.payload,
  );
  const threadId = getCommunicationThreadIdFromTaskPayload(
    params.cloudJob.payload,
  );

  try {
    const result = await provider.addReaction({
      channelId: jobChannelId,
      messageId: params.parsedBody.messageTs,
      name: params.parsedBody.name,
      ...(serviceUrl ? { serviceUrl } : {}),
      ...(threadId ? { threadId } : {}),
    });

    return new Response(
      JSON.stringify({
        channelId: result.channelId,
        messageTs: result.messageId,
        name: result.name,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  } catch (error) {
    if (error instanceof UnsupportedCommunicationOperationError) {
      return new Response(
        JSON.stringify({
          error: [error.message, error.help].filter(Boolean).join(' '),
        }),
        { status: 400 },
      );
    }

    return new Response(
      JSON.stringify({
        error: `Teams reaction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
      { status: 502 },
    );
  }
}

async function postTelegramThreadReplyFooterBestEffort(params: {
  provider: TelegramCommunicationProvider;
  cloudJob: CommunicationReplyCloudJob;
  channelId: string;
  threadId: string | null;
}): Promise<void> {
  const footerText = await buildCommunicationThreadReplyFooterTextBestEffort({
    provider: 'telegram',
    providerLabel: 'Telegram',
    cloudJob: params.cloudJob,
    logContext: LOG_CONTEXT,
  });

  if (!footerText) {
    return;
  }

  const footerStateThreadId = params.threadId ?? 'root';

  try {
    await deliverManagedThreadReplyFooter({
      provider: 'telegram',
      providerLabel: 'Telegram',
      channelId: params.channelId,
      footerStateThreadId,
      lockKey: `${TELEGRAM_THREAD_REPLY_FOOTER_LOCK_PREFIX}${params.channelId}:${footerStateThreadId}`,
      cloudJobId: params.cloudJob.id,
      logContext: LOG_CONTEXT,
      postReplyWithFooter: async () => ({
        ...(await params.provider.postMessage({
          channelId: params.channelId,
          ...(params.threadId ? { threadId: params.threadId } : {}),
          text: footerText,
          textFormat: 'markdown',
        })),
        textWithoutFooter: '',
      }),
      clearPreviousFooter: async (previousFooterRecord) => {
        await params.provider.deleteMessage({
          channelId: params.channelId,
          messageId: previousFooterRecord.messageId,
        });
      },
    });
  } catch (error) {
    console.error(
      `[${LOG_CONTEXT}] Failed to post Telegram reply footer for cloud job ${params.cloudJob.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function maybeSendCommunicationThreadReply(params: {
  cloudJob: CommunicationReplyCloudJob;
  parsedBody: ParsedThreadReplyBody;
}): Promise<Response | null> {
  const provider = getCommunicationProviderFromTaskPayload(
    params.cloudJob.payload,
  );

  switch (provider) {
    case 'teams':
      return sendTeamsThreadReply(params);
    case 'telegram':
      return sendTelegramThreadReply(params);
    default:
      return null;
  }
}

export async function maybeAddCommunicationReaction(params: {
  cloudJob: { id: number; payload: unknown };
  parsedBody: { channel: string; messageTs: string; name: string };
}): Promise<Response | null> {
  switch (getCommunicationProviderFromTaskPayload(params.cloudJob.payload)) {
    case 'teams':
      return addTeamsReaction(params);
    case 'telegram':
      return addTelegramReaction(params);
    default:
      return null;
  }
}
