import {
  UnsupportedCommunicationOperationError,
  clearLatestUserMessageForReplyQuoteIfId,
  chunkDiscordMessage,
  getLatestInboundMessageId,
  getLatestUserMessageForReplyQuote,
  type DiscordCommunicationProvider,
  type TelegramCommunicationProvider,
} from '@roomote/communication';
import {
  db,
  and,
  eq,
  getTaskAutomationInitiatorKey,
  sql,
  taskRuns,
  upsertBackgroundAutomationSlackThread,
} from '@roomote/db/server';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
} from '@roomote/types';
import {
  createDiscordCommunicationProviderFromRuntimeCredentials as createDiscordCommunicationProvider,
  createTeamsCommunicationProviderFromRuntimeCredentials as createTeamsCommunicationProvider,
  createTelegramCommunicationProviderFromRuntimeCredentials as createTelegramCommunicationProvider,
  getCommunicationProviderAdapter,
} from '@roomote/sdk/server';
import { createHash } from 'node:crypto';

import { THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE } from './chat-reply-helpers';
import {
  buildCommunicationThreadReplyFooterTextBestEffort,
  deliverManagedThreadReplyFooter,
  getCommunicationReplyImages,
  type CommunicationReplyTaskRun,
  type ParsedThreadReplyBody,
} from './communication-thread-reply-shared';
import { buildCommunicationTaskThreadName } from '../tasks/communication-task-thread.js';

const LOG_CONTEXT = 'communicationThreadReplies';
const TEAMS_THREAD_REPLY_FOOTER_LOCK_PREFIX = 'teams:thread_reply_footer_lock:';
const DISCORD_THREAD_REPLY_FOOTER_LOCK_PREFIX =
  'discord:thread_reply_footer_lock:';
const DISCORD_THREAD_REPLY_QUOTE_MAX_LENGTH = 280;

// Telegram clears a chat action after ~5s; re-send inside that window so the
// "typing…" indicator spans the whole reply delivery (chunks, photo fetch,
// message delivery) instead of lapsing partway through.
const TELEGRAM_TYPING_HEARTBEAT_MS = 4_000;

function normalizeDiscordQuoteText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeDiscordMarkdownText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('`', '\\`')
    .replaceAll('~', '\\~')
    .replaceAll('|', '\\|')
    .replaceAll('>', '\\>');
}

function truncateDiscordQuoteText(text: string): string {
  if (text.length <= DISCORD_THREAD_REPLY_QUOTE_MAX_LENGTH) {
    return text;
  }

  return `${text.slice(0, DISCORD_THREAD_REPLY_QUOTE_MAX_LENGTH).trimEnd()}...`;
}

function buildDiscordThreadReplyQuote(params: {
  username: string;
  text: string;
}): string | null {
  const username = escapeDiscordMarkdownText(
    normalizeDiscordQuoteText(params.username),
  );
  const text = escapeDiscordMarkdownText(
    truncateDiscordQuoteText(normalizeDiscordQuoteText(params.text)),
  );

  if (!username || !text) {
    return null;
  }

  // Discord markdown blockquote — matches Slack's ">*name:* text" shape.
  return `> **${username}:** ${text}`;
}

function getDiscordFooterlessFinalChunk(params: {
  textWithFooter: string;
  footerText: string;
}): string {
  const finalChunk = chunkDiscordMessage(params.textWithFooter).at(-1) ?? '';

  if (finalChunk === params.footerText) {
    return '';
  }

  const footerSuffix = `\n\n${params.footerText}`;
  return finalChunk.endsWith(footerSuffix)
    ? finalChunk.slice(0, -footerSuffix.length)
    : finalChunk;
}

async function peekDiscordThreadReplyQuote(params: { runId: number }): Promise<{
  pendingUserMessage: { id: string; text: string; userName: string };
  quote: string;
} | null> {
  try {
    const latestUserMessage = await getLatestUserMessageForReplyQuote(
      'discord',
      params.runId,
    );

    if (!latestUserMessage || latestUserMessage.text.trim().length === 0) {
      return null;
    }

    const quote = buildDiscordThreadReplyQuote({
      username: latestUserMessage.userName,
      text: latestUserMessage.text,
    });

    if (!quote) {
      return null;
    }

    return {
      pendingUserMessage: latestUserMessage,
      quote,
    };
  } catch (error) {
    console.error(
      `[${LOG_CONTEXT}] Failed to build Discord reply quote: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}

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

// Discord clears a typing indicator after ~10s; re-trigger inside that window
// so "typing…" spans the whole reply delivery instead of lapsing partway
// through.
const DISCORD_TYPING_HEARTBEAT_MS = 8_000;

async function bindLateCommunicationReportThread(params: {
  taskRun: CommunicationReplyTaskRun;
  provider: 'teams' | 'telegram' | 'discord';
  messageId: string;
  discordProvider?: DiscordCommunicationProvider;
  discordThreadName?: string;
}): Promise<void> {
  const channelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );

  if (!channelId) {
    return;
  }

  // Every automation-launched report root gets bound, so replies to it route
  // back to the task on any provider.
  const automationKey = await getTaskAutomationInitiatorKey(
    params.taskRun.taskId,
  );

  if (!automationKey) {
    return;
  }

  let discordThread: { channelId: string } | null = null;
  if (params.provider === 'discord' && params.discordProvider) {
    try {
      discordThread = await params.discordProvider.createThreadFromMessage({
        channelId,
        messageId: params.messageId,
        name: buildCommunicationTaskThreadName(
          params.discordThreadName ?? 'Roomote report',
        ),
      });
    } catch (error) {
      console.error(
        `[${LOG_CONTEXT}] Failed to create Discord report thread for task ${params.taskRun.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const patch = JSON.stringify({
    communicationMessageId: params.messageId,
    ...(params.provider === 'teams'
      ? { communicationThreadId: params.messageId }
      : discordThread
        ? {
            communicationThreadId: discordThread.channelId,
            discordTaskThread: true,
          }
        : {}),
  });
  const unboundReportCondition = discordThread
    ? sql`(
        ${taskRuns.payload}->>'communicationMessageId' IS NULL
        OR (
          ${taskRuns.payload}->>'communicationMessageId' = ${params.messageId}
          AND ${taskRuns.payload}->>'communicationThreadId' IS NULL
        )
      )`
    : sql`${taskRuns.payload}->>'communicationMessageId' IS NULL`;
  await db.transaction(async (tx) => {
    const boundRuns = await tx
      .update(taskRuns)
      .set({
        payload: sql`coalesce(${taskRuns.payload}, '{}'::jsonb) || ${patch}::jsonb`,
      })
      .where(
        and(eq(taskRuns.taskId, params.taskRun.taskId), unboundReportCondition),
      )
      .returning({ id: taskRuns.id });

    if (boundRuns.length === 0) {
      return;
    }
    await upsertBackgroundAutomationSlackThread(tx, {
      surface: params.provider,
      automationKey,
      slackChannelId: channelId,
      threadTs: params.messageId,
      summaryText: '',
      postedAt: new Date(),
      metadata: { sourceTaskId: params.taskRun.taskId },
    });
  });
}

/**
 * Show "typing…" while a Discord reply is being delivered. Fires immediately,
 * then on a heartbeat until the returned stop function runs. Entirely
 * best-effort: a typing failure must never disrupt the actual reply.
 */
function startDiscordTypingHeartbeat(
  provider: DiscordCommunicationProvider,
  input: { channelId: string; threadId?: string },
): () => void {
  const fire = () => {
    void provider
      .triggerTyping({
        channelId: input.channelId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      })
      .catch((error) => {
        console.error(
          `[${LOG_CONTEXT}] Discord typing action failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };

  fire();
  const timer = setInterval(fire, DISCORD_TYPING_HEARTBEAT_MS);
  timer.unref?.();

  return () => clearInterval(timer);
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

  await bindLateCommunicationReportThread({
    taskRun: params.taskRun,
    provider: 'teams',
    messageId: reply.messageId,
  }).catch((error) =>
    console.error(`[${LOG_CONTEXT}] Failed to bind Teams report root:`, error),
  );
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

  await bindLateCommunicationReportThread({
    taskRun: params.taskRun,
    provider: 'telegram',
    messageId: reply.messageId,
  }).catch((error) =>
    console.error(
      `[${LOG_CONTEXT}] Failed to bind Telegram report root:`,
      error,
    ),
  );
  return new Response(JSON.stringify({ messageTs: reply.messageId }), {
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Email replies must be delivered at most once per logical reply, and the MCP
 * thread-reply request carries no client-supplied message id or dedupe nonce.
 * The stable per-reply identity is therefore derived from the run id plus a
 * digest of the reply text: an HTTP/provider retry of the same tool call maps
 * to the same Idempotency-Key while a genuinely new reply gets a new one.
 */
function buildAgentMailThreadReplyIdempotencyKey(params: {
  conversationId: string;
  runId: number;
  text: string;
}): string {
  const logicalEventId = `${params.runId}-${createHash('sha256')
    .update(params.text)
    .digest('hex')
    .slice(0, 16)}`;

  return `agentmail:${params.conversationId}:${logicalEventId}:thread-reply`;
}

async function sendAgentMailThreadReply(params: {
  taskRun: CommunicationReplyTaskRun;
  parsedBody: ParsedThreadReplyBody;
}): Promise<Response> {
  const channelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  // For email tasks the payload thread id is the INTERNAL AgentMail
  // conversation id; the adapter resolves the actual reply anchor and
  // recipient from the durable conversation row at send time.
  const conversationId = getCommunicationThreadIdFromTaskPayload(
    params.taskRun.payload,
  );

  if (!channelId || !conversationId) {
    return new Response(
      JSON.stringify({
        error:
          'Email thread reply is only available for jobs with an email conversation context',
      }),
      { status: 403 },
    );
  }

  const provider = await getCommunicationProviderAdapter('agentmail');
  if (!provider) {
    return new Response(
      JSON.stringify({
        error: 'AgentMail credentials are not configured for outbound replies',
      }),
      { status: 503 },
    );
  }

  const text = params.parsedBody.text?.trim();
  if (!text) {
    return new Response(
      JSON.stringify({
        error:
          'Email thread replies require text; image attachments are not supported over email yet',
      }),
      { status: 400 },
    );
  }

  // Email is not live: no typing heartbeat, no reactions, and no managed
  // footer edits (a sent email cannot be updated). The reply text is already
  // composed by the worker; delivery only needs the durable conversation
  // route plus an Idempotency-Key so retries never double-send.
  const reply = await provider.postMessage({
    channelId,
    threadId: conversationId,
    text,
    textFormat: 'markdown',
    idempotencyKey: buildAgentMailThreadReplyIdempotencyKey({
      conversationId,
      runId: params.taskRun.id,
      text,
    }),
  });

  return new Response(
    JSON.stringify({
      messageTs: reply.messageId,
      ...(params.parsedBody.images.length > 0
        ? {
            warning:
              'Email replies do not support image attachments yet; the reply was sent without them.',
          }
        : {}),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

async function sendDiscordThreadReply(params: {
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
          'Discord thread reply is only available for jobs with Discord channel context',
      }),
      { status: 403 },
    );
  }

  const provider = await createDiscordCommunicationProvider();
  if (!provider) {
    return new Response(
      JSON.stringify({
        error: 'Discord bot token is not configured for outbound replies',
      }),
      { status: 503 },
    );
  }
  const { images, errorResponse } = await getCommunicationReplyImages({
    taskRun: { id: params.taskRun.id, taskId: params.taskRun.taskId },
    parsedBody: params.parsedBody,
  });
  if (errorResponse) return errorResponse;
  const text = params.parsedBody.text?.trim();
  if (!text && images.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'Discord thread replies require text or image attachments',
      }),
      { status: 400 },
    );
  }

  const pendingQuote = await peekDiscordThreadReplyQuote({
    runId: params.taskRun.id,
  });
  const textWithQuote =
    text && pendingQuote ? `${pendingQuote.quote}\n\n${text}` : text;
  const footerText = await buildCommunicationThreadReplyFooterTextBestEffort({
    provider: 'discord',
    providerLabel: 'Discord',
    taskRun: params.taskRun,
    logContext: LOG_CONTEXT,
  });
  const textWithFooter = footerText
    ? [textWithQuote, footerText].filter(Boolean).join('\n\n')
    : textWithQuote;

  // The reply text is already composed by the worker; the only window the API
  // owns is this delivery. Show "typing…" across it so the message(s) don't
  // land abruptly after the silence, and stop the instant delivery finishes.
  const stopTyping = startDiscordTypingHeartbeat(provider, {
    channelId,
    ...(threadId ? { threadId } : {}),
  });

  let reply;
  try {
    const postDiscordReply = () =>
      provider.postMessage({
        channelId,
        // Discord thread channels are real destinations (threadId). When the
        // task only has a root message id (e.g. a channel investigating opener),
        // attach via replyToMessageId so closeouts stay on that message instead
        // of posting a free-floating channel message.
        ...(threadId ? { threadId } : {}),
        ...(!threadId && messageId ? { replyToMessageId: messageId } : {}),
        ...(textWithFooter ? { text: textWithFooter } : {}),
        textFormat: 'markdown',
        images,
      });

    if (!footerText) {
      reply = await postDiscordReply();
    } else {
      const footerStateThreadId = threadId ?? messageId ?? 'root';
      const footerMessageChannelId = threadId ?? channelId;
      const footerlessFinalChunk = getDiscordFooterlessFinalChunk({
        textWithFooter: textWithFooter ?? footerText,
        footerText,
      });

      reply = await deliverManagedThreadReplyFooter({
        provider: 'discord',
        providerLabel: 'Discord',
        channelId,
        footerStateThreadId,
        lockKey: `${DISCORD_THREAD_REPLY_FOOTER_LOCK_PREFIX}${channelId}:${footerStateThreadId}`,
        runId: params.taskRun.id,
        logContext: LOG_CONTEXT,
        postReplyWithFooter: async () => {
          const posted = await postDiscordReply();

          return {
            ...posted,
            messageId: posted.lastTextMessageId ?? posted.messageId,
            textWithoutFooter: footerlessFinalChunk,
          };
        },
        clearPreviousFooter: async (previousFooterRecord) => {
          await provider.editMessage({
            channelId: footerMessageChannelId,
            messageId: previousFooterRecord.messageId,
            text: previousFooterRecord.textWithoutFooter,
          });
        },
      });
    }

    if (pendingQuote) {
      try {
        // Clear only the exact quote id delivered here. A newer web message
        // (even with the same user + text) gets a new id and must remain.
        await clearLatestUserMessageForReplyQuoteIfId(
          'discord',
          params.taskRun.id,
          pendingQuote.pendingUserMessage.id,
        );
      } catch (error) {
        console.error(
          `[${LOG_CONTEXT}] Failed to clear Discord reply quote for task run ${params.taskRun.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } finally {
    stopTyping();
  }

  await bindLateCommunicationReportThread({
    taskRun: params.taskRun,
    provider: 'discord',
    messageId: messageId ?? reply.messageId,
    ...(!threadId
      ? {
          discordProvider: provider,
          ...(text ? { discordThreadName: text } : {}),
        }
      : {}),
  }).catch((error) =>
    console.error(
      `[${LOG_CONTEXT}] Failed to bind Discord report root:`,
      error,
    ),
  );
  return new Response(JSON.stringify({ messageTs: reply.messageId }), {
    headers: { 'content-type': 'application/json' },
  });
}

async function addDiscordReaction(params: {
  taskRun: { id: number; payload: unknown };
  parsedBody: { channel: string; messageTs: string; name: string };
}): Promise<Response> {
  const channelId = getCommunicationChannelFromTaskPayload(
    params.taskRun.payload,
  );
  const destinationId =
    getCommunicationThreadIdFromTaskPayload(params.taskRun.payload) ??
    channelId;
  const requestedChannelId = params.parsedBody.channel.replace(/^#/, '');
  if (!destinationId || !channelId || requestedChannelId !== channelId) {
    return new Response(
      JSON.stringify({
        error:
          'Discord reactions are only available for the channel this task was launched from',
      }),
      { status: 403 },
    );
  }
  const provider = await createDiscordCommunicationProvider();
  if (!provider) {
    return new Response(
      JSON.stringify({ error: 'Discord bot token is not configured' }),
      { status: 503 },
    );
  }
  try {
    const result = await provider.addReaction({
      channelId: destinationId,
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
    return new Response(
      JSON.stringify({
        error: `Discord reaction failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
      { status: 502 },
    );
  }
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

/**
 * Email has no reactions. Report the limitation gracefully (mirroring the
 * UnsupportedCommunicationOperationError shape other providers surface)
 * instead of erroring at the provider.
 */
function addAgentMailReaction(): Response {
  return new Response(
    JSON.stringify({
      error:
        'AgentMail does not support reactions. Email has no reactions; send a reply instead.',
    }),
    { status: 400 },
  );
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
    case 'discord':
      return sendDiscordThreadReply(params);
    case 'agentmail':
      return sendAgentMailThreadReply(params);
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
    case 'discord':
      return addDiscordReaction(params);
    case 'agentmail':
      return addAgentMailReaction();
    default:
      return null;
  }
}
