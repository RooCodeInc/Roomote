import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { Env } from '@roomote/env';
import {
  acquireFastAgentTurnLock,
  fastAgentConversationRepository,
} from '@roomote/cloud-agents/server';
import {
  activateTelegramManagedBot,
  beginTelegramManagedBotPairing,
  disconnectTelegramManagedBot,
  getTelegramManagedBotRoute,
  provisionTelegramManagedBot,
  recordTelegramManagedBotCandidate,
  resolveTelegramManagedBotCredentials,
  resolveTelegramRuntimeCredentials,
  selectTelegramManagedBotCandidate,
} from '@roomote/db/server';
import {
  parseTelegramUpdate,
  telegramUpdateToQueuedCommunicationMessage,
  type TelegramUpdate,
  type TelegramMessage,
} from '@roomote/communication/telegram-update';
import {
  findFastAgentSessionForProviderReply,
  queueFastAgentSurfaceReply,
} from '@roomote/sdk/server';
import { resolveTelegramSenderUserId } from './linked-user.js';
import { attachTelegramMediaToQueuedMessage } from './attachments.js';
import type { QueuedTelegramCommunicationMessage } from './types.js';

async function telegramApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  try {
    const base = (
      process.env.TELEGRAM_API_BASE_URL ??
      Env.TELEGRAM_API_BASE_URL ??
      'https://api.telegram.org'
    ).replace(/\/+$/, '');
    const response = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: unknown;
    };
    if (!response.ok || payload.ok !== true)
      throw new Error('Telegram API rejected request');
    return payload.result;
  } catch {
    // Transport errors can contain the token-bearing URL. Never propagate them.
    throw new Error(`Managed Telegram ${method} failed`);
  }
}

function privateOwnerMessage(
  message: TelegramMessage | undefined,
  owner: string,
  allowTopic = false,
) {
  return Boolean(
    message &&
    message.chat.type === 'private' &&
    String(message.chat.id) === owner &&
    (allowTopic || !message.message_thread_id) &&
    !message.sender_chat &&
    !message.business_connection_id &&
    !message.guest_query_id,
  );
}

function validBot(
  bot: { id: number; is_bot?: boolean; username?: string } | undefined,
) {
  return Boolean(
    bot &&
    Number.isSafeInteger(bot.id) &&
    bot.id > 0 &&
    bot.is_bot === true &&
    bot.username &&
    /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(bot.username),
  );
}

/** Called only behind the MAIN bot webhook secret. Native updates have no request_id echo. */
export async function handleTelegramManagedBotUpdate(
  update: TelegramUpdate,
): Promise<boolean> {
  const message = update.message;
  const callback = update.callback_query;
  const isCommand = /^\/sessionbot(?:@[A-Za-z0-9_]+)?\s*$/u.test(
    message?.text?.trim() ?? '',
  );
  const isConfirmation = callback?.data?.startsWith('sessionbot:') ?? false;
  const managed = update.managed_bot;
  const created = message?.managed_bot_created;
  if (!isCommand && !isConfirmation && !managed && !created) return false;
  const owner = String(
    managed?.user.id ??
      (isConfirmation ? callback?.from.id : message?.from?.id) ??
      '',
  );
  if (
    !/^[1-9][0-9]*$/.test(owner) ||
    managed?.user.is_bot ||
    (!managed &&
      (!privateOwnerMessage(
        isConfirmation ? callback?.message : message,
        owner,
        true,
      ) ||
        (isConfirmation ? callback?.from.is_bot : message?.from?.is_bot)))
  )
    return true;
  const { botToken } = await resolveTelegramRuntimeCredentials();
  if (!botToken) throw new Error('Main Telegram bot not configured');
  const send = (text: string, reply_markup?: Record<string, unknown>) =>
    telegramApi(botToken, 'sendMessage', {
      chat_id: owner,
      text,
      ...(reply_markup ? { reply_markup } : {}),
    });
  if (managed || created) {
    const bot = managed?.bot ?? created?.bot;
    if (
      !bot ||
      !Number.isSafeInteger(bot.id) ||
      bot.id <= 0 ||
      bot.is_bot !== true
    )
      return true;
    const result = await recordTelegramManagedBotCandidate({
      ownerTelegramUserId: owner,
      botId: String(bot!.id),
      botUsername: validBot(bot) ? bot.username! : null,
      ...(managed ? { managementUpdateId: update.update_id } : {}),
    });
    if (result)
      await send(
        `Confirm which Session should use @${result.candidate.botUsername}. This does not create a new Session.`,
        {
          inline_keyboard: [
            [
              {
                text: `Use @${result.candidate.botUsername} for Session ${result.pairing.sessionId}`,
                callback_data: `sessionbot:${result.candidate.id}`,
              },
            ],
          ],
        },
      );
    return true;
  }
  const userId = await resolveTelegramSenderUserId(owner);
  if (!userId) {
    await send(
      'Link your Telegram account in Roomote before connecting a session bot.',
    );
    return true;
  }
  if (isCommand) {
    const reply = message?.reply_to_message;
    const replyId =
      reply &&
      typeof reply === 'object' &&
      'message_id' in reply &&
      typeof reply.message_id === 'number'
        ? String(reply.message_id)
        : undefined;
    const session = await findFastAgentSessionForProviderReply({
      provider: 'telegram',
      workspaceId: owner,
      channelId: owner,
      userId,
      ...(message?.message_thread_id
        ? { threadId: String(message.message_thread_id) }
        : {}),
      ...(replyId ? { replyToMessageId: replyId } : {}),
    });
    if (
      (!session && (replyId || message?.message_thread_id)) ||
      (session &&
        (session.userId !== userId ||
          session.conversation.surface !== 'telegram'))
    ) {
      await send(
        'No existing private Fast Session was found here. Start a conversation first, then send /sessionbot.',
      );
      return true;
    }
    const result = await beginTelegramManagedBotPairing({
      ...(session ? { sessionId: session.id } : {}),
      ownerUserId: userId,
      ownerTelegramUserId: owner,
    });
    if (!result) {
      await send(
        'No eligible existing private Fast Session was found here. Start a conversation first, then send /sessionbot. Sessions that already have a bot binding cannot be rebound.',
      );
      return true;
    }
    const { pairing } = result;
    if (pairing.state === 'provisioning' || pairing.state === 'ready') {
      await send(
        `@${pairing.botUsername} is already selected for Session ${pairing.sessionId}. Use its original confirmation button again to retry setup or reopen the connection link. A different bot cannot replace this selection.`,
      );
      return true;
    }
    await send(
      `${result.existing ? 'A request is already pending for' : 'Create a bot for'} Session ${pairing.sessionId}? Only one request can be pending at a time (15 minutes). The main bot must have Bot Management Mode enabled by its operator in BotFather. You can edit the suggested username in Telegram. You will confirm the exact bot and Session next.`,
      {
        keyboard: [
          [
            {
              text: 'Yes, create bot',
              request_managed_bot: {
                request_id: 1,
                suggested_name: `Roomote Session ${pairing.sessionId.slice(0, 8)}`,
                suggested_username: `roomote_${pairing.id.replaceAll('-', '').slice(0, 16)}_bot`,
              },
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    );
    return true;
  }
  await telegramApi(botToken, 'answerCallbackQuery', {
    callback_query_id: callback!.id,
  }).catch(() => {});
  const candidateId = callback!.data!.slice('sessionbot:'.length);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      candidateId,
    )
  )
    return true;
  const selected = await selectTelegramManagedBotCandidate(candidateId, owner);
  if (!selected) {
    await send(
      'That selection is expired, already used, or conflicts with the bot already selected. No binding was changed.',
    );
    return true;
  }
  const provisioned = await provisionTelegramManagedBot(
    selected.id,
    owner,
    async ({ botId, webhookSecret }) => {
      const token = await telegramApi(botToken, 'getManagedBotToken', {
        user_id: Number(botId),
      });
      if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token))
        throw new Error('Invalid managed bot token');
      const me = (await telegramApi(token, 'getMe', {})) as {
        id: number;
        is_bot?: boolean;
        username?: string;
      };
      if (!validBot(me) || String(me.id) !== botId)
        throw new Error('Managed bot identity mismatch');
      const url = new URL(
        `/api/webhooks/telegram/managed/${botId}`,
        Env.R_PUBLIC_URL ?? Env.R_APP_URL,
      );
      if (url.protocol !== 'https:')
        throw new Error('Managed bots require a public HTTPS webhook URL');
      await telegramApi(token, 'setWebhook', {
        url: url.href,
        secret_token: webhookSecret,
        allowed_updates: ['message', 'callback_query'],
      });
      return { botToken: token, botUsername: me.username! };
    },
  );
  if (provisioned)
    await send(
      'Open your session bot within five minutes to finish connecting this existing Session. Only your linked Telegram account can activate it.',
      {
        inline_keyboard: [
          [
            {
              text: 'Open session bot',
              url: `https://t.me/${provisioned.botUsername}?start=${provisioned.ticket}`,
            },
          ],
        ],
      },
    );
  return true;
}

export const telegramManagedBots = new Hono();
telegramManagedBots.post('/:botId', async (c) => {
  const botId = c.req.param('botId');
  if (!/^[1-9][0-9]*$/.test(botId)) return c.json({ ok: false }, 401);
  const route = await getTelegramManagedBotRoute(botId);
  const supplied = c.req.header('x-telegram-bot-api-secret-token');
  if (
    !route ||
    !supplied ||
    Buffer.byteLength(supplied) !== Buffer.byteLength(route.webhookSecret) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(route.webhookSecret))
  )
    return c.json({ ok: false }, 401);
  const parsed = parseTelegramUpdate(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false }, 400);
  const update = parsed.data;
  const message = update.message;
  const callback = update.callback_query;
  const actor = callback?.from ?? message?.from;
  if (
    !actor ||
    actor.is_bot ||
    String(actor.id) !== route.ownerTelegramUserId ||
    !privateOwnerMessage(
      callback?.message ?? message,
      route.ownerTelegramUserId,
    )
  )
    return c.json({ ok: true, ignored: 'owner_only' });
  if (
    (await resolveTelegramSenderUserId(String(actor.id))) !== route.ownerUserId
  )
    return c.json({ ok: true, ignored: 'owner_mapping_changed' });
  const send = async (text: string) => {
    const current = await getTelegramManagedBotRoute(botId);
    if (current?.id === route.id)
      await telegramApi(current.botToken, 'sendMessage', {
        chat_id: route.ownerTelegramUserId,
        text,
      });
  };
  const text = message?.text?.trim() ?? '';
  if (/^\/disconnect(?:@[A-Za-z0-9_]+)?\s*$/u.test(text)) {
    const disconnected = await disconnectTelegramManagedBot(
      botId,
      route.ownerTelegramUserId,
    );
    if (disconnected) {
      // One terminal receipt to the already-authorized owner is permitted
      // after revocation. Never re-resolve or restore a delivery route for it.
      await telegramApi(route.botToken, 'sendMessage', {
        chat_id: route.ownerTelegramUserId,
        text: 'Disconnected. This bot will no longer continue your Session. Your Session has not been deleted.',
      }).catch(() => {});
    }
    return c.json({ ok: true, disconnected });
  }
  if (callback) {
    const current = await resolveTelegramManagedBotCredentials(
      `telegram-bot:${botId}`,
    );
    if (current?.sessionId === route.sessionId)
      await telegramApi(current.botToken, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'This action is not supported in a session bot. Send a message instead.',
      }).catch(() => {});
    return c.json({ ok: true, ignored: 'unsupported_action' });
  }
  const start = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/u.exec(text);
  if (start) {
    if (start[1]) {
      const session = await fastAgentConversationRepository.findById({
        id: route.sessionId,
      });
      if (
        !session ||
        session.userId !== route.ownerUserId ||
        session.conversation.surface !== 'telegram'
      )
        return c.json({ ok: true, activated: false });
      // Migration changes the Redis turn-lock namespace. Hold the old lock so
      // an existing main-bot turn must settle before the durable route moves.
      const release = await acquireFastAgentTurnLock({
        conversation: session.conversation,
        maxWaitMs: 0,
      });
      if (!release) {
        await send(
          'This Session is still responding. Open this connection link again when it is idle, before the link expires.',
        );
        return c.json({ ok: true, activated: false });
      }
      let activated: string | null;
      try {
        activated = await activateTelegramManagedBot(
          botId,
          route.ownerTelegramUserId,
          start[1],
        );
      } finally {
        await release();
      }
      await send(
        activated
          ? `Connected to Session ${activated}. Messages here continue that Session. /disconnect stops delivery without deleting it.`
          : 'That connection link is invalid, expired, already used, or the Session has pending work. No binding was changed. Retry while the Session is idle and the link is still valid.',
      );
      return c.json({ ok: true, activated: Boolean(activated) });
    }
    if (route.state === 'active')
      await send(
        `This bot continues Session ${route.sessionId}. /disconnect stops delivery without deleting it.`,
      );
    return c.json({ ok: true });
  }
  if (route.state !== 'active')
    return c.json({ ok: true, ignored: 'not_active' });
  if (/^\//u.test(text)) {
    await send(
      'This bot stays with the same Session. Send a message to continue it, or /disconnect to stop delivery. /new does not create another Session here.',
    );
    return c.json({ ok: true, ignored: 'command' });
  }
  if (!message) return c.json({ ok: true, ignored: 'unsupported_update' });
  let queued = telegramUpdateToQueuedCommunicationMessage(update, {
    userId: route.ownerUserId,
  }) as QueuedTelegramCommunicationMessage | null;
  if (!queued) return c.json({ ok: true, ignored: 'unsupported_message' });
  queued = await attachTelegramMediaToQueuedMessage({
    message,
    queuedMessage: queued,
    botToken: route.botToken,
  });
  const current = await resolveTelegramManagedBotCredentials(
    `telegram-bot:${botId}`,
  );
  if (
    !current ||
    current.sessionId !== route.sessionId ||
    current.ownerTelegramUserId !== String(actor.id)
  )
    return c.json({ ok: true, ignored: 'revoked' });
  if (!queued.text.trim())
    return c.json({ ok: true, ignored: 'empty_message' });
  // Durable admission deduplicates this bot-scoped identity; no Redis claim can
  // acknowledge a message before its queue write succeeds.
  const admitted = await queueFastAgentSurfaceReply({
    sessionId: route.sessionId,
    userId: route.ownerUserId,
    senderDisplayName:
      [actor.first_name, actor.last_name].filter(Boolean).join(' ') || null,
    question: queued.text.trim(),
    currentMessageId: `telegram-bot:${botId}:${update.update_id}`,
    replyToMessageId: String(message.message_id),
    ...(queued.images ? { images: queued.images } : {}),
  });
  return c.json({ ok: admitted, queued: admitted }, admitted ? 200 : 503);
});
