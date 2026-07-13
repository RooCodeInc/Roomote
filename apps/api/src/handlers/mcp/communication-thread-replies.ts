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
  type CommunicationReplyTaskRun,
  type ParsedThreadReplyBody,
} from './communication-thread-reply-shared';

const LOG_CONTEXT = 'communicationThreadReplies';
const TEAMS_THREAD_REPLY_FOOTER_LOCK_PREFIX = 'teams:thread_reply_footer_lock:';

// Telegram clears a chat action after ~5s; re-send inside that window so the
// "typing…" indicator spans the whole reply delivery (chunks, photo fetch,
// message delivery) instead of lapsing partway through.
const TELEGRAM_TYPING_HEARTBEAT_MS = 4_000;

/**
 * Show "typing…" while a Telegram reply is being delivered. Fires immediately,
 * then on a heartbeat until the returned stop function runs. Entirely
 * best-effort: a chat-action failure must never disrupt the actual reply.
 */
function startTelegramTypingHeartbeat(
  provider: TelegramCommunicationProvider,
  input: { channelId: string; threadId?: string },
): () => void {
  const fire = () => {
    void provider
      .sendChatAction({
        channelId: input.channelId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      })
      .catch((error) => {
        console.error(
          `[${LOG_CONTEXT}] Telegram typing action failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };

  fire();
  const timer = setInterval(fire, TELEGRAM_TYPING_HEARTBEAT_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}

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
  taskRun: CommunicationReplyTaskRun;
  parsedBody: ParsedThreadReplyBody;
}): Promise<Response> {
  const channelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(
    params.taskRun.payload,
  );
  const threadId = getCommunicationThreadIdFromTaskPayload(
    params.taskRun.payload,
  );
  const messageId = getCommunicationMessageIdFromTaskPayload(
    params.taskRun.payload,
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
    taskRun: { id: params.taskRun.id, taskId: params.taskRun.taskId },
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
    taskRun: params.taskRun,
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
        runId: params.taskRun.id,
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
  taskRun: CommunicationReplyTaskRun;
  parsedBody: ParsedThreadReplyBody;
}): Promise<Response> {
  const channelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const threadId = getCommunicationThreadIdFromTaskPayload(
    params.taskRun.payload,
  );
  const messageId = getCommunicationMessageIdFromTaskPayload(
    params.taskRun.payload,
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
    taskRun: { id: params.taskRun.id, taskId: params.taskRun.taskId },
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
      params.taskRun.id,
    );
    if (latestInboundMessageId) {
      replyToMessageId = latestInboundMessageId;
    }
  } catch (error) {
    console.error(
      `[${LOG_CONTEXT}] Failed to read latest inbound Telegram message id for task run ${params.taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // The reply text is already composed by the worker; the only window the API
  // owns is this delivery. Show "typing…" across it so the message(s) don't
  // land abruptly after the silence, and stop the instant delivery finishes.
  const stopTyping = startTelegramTypingHeartbeat(provider, {
    channelId,
    ...(threadId ? { threadId } : {}),
  });

  let reply;
  try {
    reply = await provider.postMessage({
      channelId,
      ...(threadId ? { threadId } : {}),
      replyToMessageId: replyToMessageId ?? undefined,
      ...(text ? { text } : {}),
      textFormat: 'markdown',
      images,
    });
  } finally {
    stopTyping();
  }

  return new Response(JSON.stringify({ messageTs: reply.messageId }), {
    headers: { 'content-type': 'application/json' },
  });
}

async function addTelegramReaction(params: {
  taskRun: { id: number; payload: unknown };
  parsedBody: { channel: string; messageTs: string; name: string };
}): Promise<Response> {
  const jobChannelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
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
  taskRun: { id: number; payload: unknown };
  parsedBody: { channel: string; messageTs: string; name: string };
}): Promise<Response> {
  const jobChannelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
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
    params.taskRun.payload,
  );
  const threadId = getCommunicationThreadIdFromTaskPayload(
    params.taskRun.payload,
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

export async function maybeSendCommunicationThreadReply(params: {
  taskRun: CommunicationReplyTaskRun;
  parsedBody: ParsedThreadReplyBody;
}): Promise<Response | null> {
  const provider = getCommunicationProviderFromTaskPayload(
    params.taskRun.payload,
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
  taskRun: { id: number; payload: unknown };
  parsedBody: { channel: string; messageTs: string; name: string };
}): Promise<Response | null> {
  switch (getCommunicationProviderFromTaskPayload(params.taskRun.payload)) {
    case 'teams':
      return addTeamsReaction(params);
    case 'telegram':
      return addTelegramReaction(params);
    default:
      return null;
  }
}
