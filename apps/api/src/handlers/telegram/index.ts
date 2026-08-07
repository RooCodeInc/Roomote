import { Hono } from 'hono';

import {
  queueCommunicationMessage,
  setLatestInboundMessageId,
} from '@roomote/communication/messages';
import {
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
  RunStatus,
  activeRunStatuses,
  isSnapshotResumable,
  isDeploymentReadOnlyError,
} from '@roomote/types';
import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';
import {
  getTelegramUpdateCallbackQuery,
  getTelegramUpdateCommunicationMetadata,
  getTelegramUpdateMessage,
  getTelegramUpdateMessageReaction,
  getTelegramNewTaskCommand,
  isTelegramImplicitTopicCreatedMessage,
  isTelegramPrivateChat,
  isTelegramStartCommand,
  isTelegramTaskEntryUpdate,
  isNewTelegramThumbsUpReaction,
  parseTelegramUpdate,
  telegramUpdateToQueuedCommunicationMessage,
} from '@roomote/communication/telegram-update';

import { apiLogger } from '../../logging.js';
import { syncActingUserForInboundMessage } from '../tasks/acting-user-sync.js';
import {
  findActiveTelegramTaskRun,
  findCompletedTelegramTaskRunWithSnapshot,
  findTelegramAutomationReportRun,
} from './task-run-lookup.js';
import { retireTelegramPrReviewOffersBestEffort } from './pr-review-action.js';
import {
  consumeTelegramLinkCode,
  isTelegramLinkCode,
  restoreTelegramLinkCode,
} from '@roomote/sdk/server';

import {
  handleTelegramCallbackQuery,
  handleTelegramSuggestionReaction,
} from './callback-actions.js';
import { handleTelegramRoutingReply } from './routing-confirmation.js';
import {
  resolveTelegramSenderUserId,
  upsertTelegramUserMapping,
} from './linked-user.js';
import { captureTelegramPrimaryChatBestEffort } from './primary-chat.js';
import {
  ackTelegramMessageBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';

const TELEGRAM_COMMAND_HELP = [
  '*Available commands*',
  '`/start` — show this welcome message.',
  '`/new <request>` — start a fresh task instead of resuming the previous one; when topics are available, it opens a new topic.',
].join('\n');

const TELEGRAM_WELCOME_MESSAGE = [
  "👋 Hi, I'm Roomote. Message me here to start tasks in your connected repos — I'll route your request, reply with progress, and post results (including screenshots) right in this chat.",
  'Try something like *"Fix the flaky auth test"* or *"What changed in the repo this week?"*. While a task is running you can send follow-ups in its chat or topic, and every started task has a cancel button.',
  TELEGRAM_COMMAND_HELP,
].join('\n\n');

const TELEGRAM_WELCOME_LINK_NUDGE =
  'Tip: link this Telegram account to your Roomote account so tasks you start here are attributed to you — generate a code under *Settings → Personal → Linked Accounts* and send it here.';

const TELEGRAM_LINK_REQUIRED_MESSAGE =
  '🔗 Link your Roomote account before starting tasks here. Generate a code under *Settings → Personal → Linked Accounts* and send it to me — until then I can’t attribute tasks to you.';
import {
  replyToTelegramSnapshotResume,
  resumeTelegramTaskFromSnapshot,
  startNewTelegramTask,
} from './task-orchestration.js';
import type { QueuedTelegramCommunicationMessage } from './types.js';
import { attachTelegramMediaToQueuedMessage } from './attachments.js';
import {
  claimTelegramLinkNudge,
  claimTelegramUpdate,
  rememberTelegramImplicitTopic,
  verifyTelegramWebhookSecret,
} from './webhook-gate.js';
import { appendAccountLinkHelpText } from '../account-link-help.js';

// Deep-link payload used by the group "link account" button: tapping
// https://t.me/<bot>?start=link opens the bot's DM with "/start link".
const TELEGRAM_LINK_START_PAYLOAD = 'link';

export const telegram = new Hono();

telegram.post('/', async (c) => {
  const verificationError = await verifyTelegramWebhookSecret(
    c.req.header('x-telegram-bot-api-secret-token'),
  );

  if (verificationError) {
    apiLogger.warn(
      `[telegram] Rejected Telegram webhook: ${verificationError.error}`,
    );

    return c.json(
      { ok: false, error: verificationError.error },
      { status: verificationError.status },
    );
  }

  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = parseTelegramUpdate(rawBody);

  if (!parsed.success) {
    return c.json(
      { ok: false, error: 'invalid_telegram_update' },
      { status: 400 },
    );
  }

  const update = parsed.data;
  const messageReaction = getTelegramUpdateMessageReaction(update);

  if (messageReaction) {
    const claimedReaction = await claimTelegramUpdate(update.update_id);
    if (!claimedReaction) {
      return c.json({ ok: true, duplicate: true });
    }
    if (!isNewTelegramThumbsUpReaction(messageReaction)) {
      return c.json({ ok: true, ignored: 'unsupported_reaction' });
    }

    const handled = await handleTelegramSuggestionReaction(messageReaction);
    return c.json(
      handled
        ? { ok: true, suggestionStarted: true }
        : { ok: true, ignored: 'reaction_target_not_suggestion' },
    );
  }

  const callbackQuery = getTelegramUpdateCallbackQuery(update);

  if (callbackQuery) {
    const claimedCallback = await claimTelegramUpdate(update.update_id);

    if (!claimedCallback) {
      return c.json({ ok: true, duplicate: true });
    }

    await handleTelegramCallbackQuery(callbackQuery);

    return c.json({ ok: true, callbackHandled: true });
  }

  const message = getTelegramUpdateMessage(update);

  if (!message) {
    return c.json({ ok: true, ignored: 'unsupported_update' });
  }

  const claimed = await claimTelegramUpdate(update.update_id);

  if (!claimed) {
    apiLogger.debug(
      `[telegram] Skipping duplicate Telegram update ${update.update_id}`,
    );
    return c.json({ ok: true, duplicate: true });
  }

  if (isTelegramImplicitTopicCreatedMessage(message)) {
    const implicitThreadId = message.message_thread_id ?? message.message_id;
    await rememberTelegramImplicitTopic({
      chatId: String(message.chat.id),
      threadId: String(implicitThreadId),
    });
    return c.json({ ok: true, implicitTopicRemembered: true });
  }

  // Account linking: a bare link code (or /start <code> from the deep link)
  // binds the sender's Telegram identity to their Roomote user.
  const messageText = message.text?.trim() ?? '';
  const startPayload = /^\/start(?:@[A-Za-z0-9_]+)?\s+(\S+)$/u.exec(
    messageText,
  )?.[1];
  const linkCodeCandidate = startPayload ?? messageText;

  if (isTelegramPrivateChat(message) && isTelegramLinkCode(linkCodeCandidate)) {
    // A follow-up to a running task could theoretically match the code
    // pattern; when the chat has an active task run, let the normal queue path
    // handle the message instead of intercepting it.
    const linkMetadata = getTelegramUpdateCommunicationMetadata(update);
    const activeRunForLinkChat = await findActiveTelegramTaskRun({
      chatId: linkMetadata.communicationChannelId,
      threadId: linkMetadata.communicationThreadId,
    });

    if (!activeRunForLinkChat) {
      const linkedUserId = await consumeTelegramLinkCode(linkCodeCandidate);
      const chatId = String(message.chat.id);

      if (!linkedUserId) {
        await postTelegramMessageBestEffort({
          chatId,
          text: 'That link code is invalid or has expired. Generate a fresh one from your Roomote settings and send it here within 10 minutes.',
        });

        return c.json({ ok: true, linked: false, reason: 'invalid_link_code' });
      }

      try {
        await upsertTelegramUserMapping({
          telegramUserId: String(message.from?.id ?? ''),
          telegramChatId: chatId,
          telegramUsername: message.from?.username ?? null,
          userId: linkedUserId,
        });
      } catch (error) {
        // The code was already consumed via GETDEL; put it back so a
        // transient DB error does not force the user to regenerate.
        await restoreTelegramLinkCode(linkCodeCandidate, linkedUserId);
        apiLogger.error(
          `[telegram] Failed to store Telegram user mapping for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await postTelegramMessageBestEffort({
          chatId,
          text: 'Something went wrong while linking your account. Your code is still valid — please send it again in a moment.',
        });

        return c.json({ ok: true, linked: false, reason: 'link_error' });
      }

      await captureTelegramPrimaryChatBestEffort({
        chatId,
        launchOwnerUserId: linkedUserId,
      });
      await postTelegramMessageBestEffort({
        chatId,
        text: [
          '✅ Linked! This Telegram account is now connected to your Roomote account. Tasks you start here are attributed to you, and Roomote can reach you in this chat.',
          'Send a request to start a task, or use:',
          TELEGRAM_COMMAND_HELP,
        ].join('\n\n'),
        textFormat: 'markdown',
      });

      return c.json({ ok: true, linked: true });
    }
  }

  // Attribution requires a linked sender: an unlinked Telegram user is never
  // treated as some other Roomote user. `senderUserId` is null until the
  // sender links their own account.
  const senderUserId = await resolveTelegramSenderUserId(
    message.from ? String(message.from.id) : undefined,
  );

  // The group "link account" button deep-links here with "/start link":
  // reply with linking instructions instead of treating "link" as a task.
  if (
    isTelegramPrivateChat(message) &&
    startPayload === TELEGRAM_LINK_START_PAYLOAD
  ) {
    await postTelegramMessageBestEffort({
      chatId: String(message.chat.id),
      text: senderUserId
        ? '✅ This Telegram account is already linked to your Roomote account — head back to the group and send your request again.'
        : await appendAccountLinkHelpText(
            'Let’s link your Telegram account: generate a code under *Settings → Personal → Linked Accounts* in Roomote, then send it here.',
          ),
      textFormat: 'markdown',
    });

    return c.json({ ok: true, linkNudged: true });
  }

  // A bare /start is Telegram's "open the bot" gesture, so greet the sender
  // even before they have linked an account — unlinked senders still need the
  // welcome and account-linking guidance.
  if (isTelegramStartCommand(update)) {
    if (senderUserId) {
      await captureTelegramPrimaryChatBestEffort({
        chatId: String(message.chat.id),
        launchOwnerUserId: senderUserId,
      });
    }

    await postTelegramMessageBestEffort({
      chatId: String(message.chat.id),
      text: senderUserId
        ? TELEGRAM_WELCOME_MESSAGE
        : `${TELEGRAM_WELCOME_MESSAGE}\n\n${await appendAccountLinkHelpText(TELEGRAM_WELCOME_LINK_NUDGE)}`,
      textFormat: 'markdown',
    });

    return c.json({ ok: true, welcomed: true });
  }

  const { botToken, botUsername } = await resolveTelegramRuntimeCredentials();

  if (!senderUserId) {
    // Nudge the sender to link instead of silently dropping their message.
    // In groups, reply only when the sender explicitly addressed the bot,
    // and rate-limit per sender and per chat so the nudge cannot be used to
    // make the bot spam the group.
    if (isTelegramPrivateChat(message)) {
      await postTelegramMessageBestEffort({
        chatId: String(message.chat.id),
        text: await appendAccountLinkHelpText(TELEGRAM_LINK_REQUIRED_MESSAGE),
        textFormat: 'markdown',
      });
    } else {
      const addressedBot =
        isTelegramTaskEntryUpdate(update, {
          botUsername: botUsername ?? undefined,
        }) ||
        getTelegramNewTaskCommand(update, {
          botUsername: botUsername ?? undefined,
        }) !== null;

      if (
        addressedBot &&
        (await claimTelegramLinkNudge({
          chatId: String(message.chat.id),
          telegramUserId: message.from ? String(message.from.id) : undefined,
        }))
      ) {
        const nudgeMetadata = getTelegramUpdateCommunicationMetadata(update);

        await postTelegramMessageBestEffort({
          chatId: nudgeMetadata.communicationChannelId,
          threadId: nudgeMetadata.communicationThreadId,
          replyToMessageId: nudgeMetadata.communicationMessageId,
          ...(botUsername
            ? {
                text: await appendAccountLinkHelpText(
                  'Link your Telegram account to Roomote first, then send your request again.',
                ),
                textFormat: 'markdown' as const,
                buttons: [
                  [
                    {
                      text: '🔗 Link account',
                      url: `https://t.me/${botUsername}?start=${TELEGRAM_LINK_START_PAYLOAD}`,
                    },
                  ],
                ],
              }
            : {
                text: await appendAccountLinkHelpText(
                  TELEGRAM_LINK_REQUIRED_MESSAGE,
                ),
                textFormat: 'markdown' as const,
              }),
        });
      }
    }

    apiLogger.debug(
      `[telegram] Ignoring message from unlinked Telegram sender for chat ${message.chat.id}`,
    );

    return c.json({
      ok: true,
      queued: false,
      reason: 'telegram_sender_not_linked',
    });
  }

  if (isTelegramPrivateChat(message)) {
    await captureTelegramPrimaryChatBestEffort({
      chatId: String(message.chat.id),
      launchOwnerUserId: senderUserId,
    });
  }

  let queuedMessage = telegramUpdateToQueuedCommunicationMessage(update, {
    botUsername: botUsername ?? undefined,
    userId: senderUserId,
  }) as QueuedTelegramCommunicationMessage | null;

  if (
    queuedMessage &&
    botToken &&
    (message.photo?.length || message.document)
  ) {
    queuedMessage = await attachTelegramMediaToQueuedMessage({
      message,
      queuedMessage,
      botToken,
    });
  }

  const metadata = getTelegramUpdateCommunicationMetadata(update);
  const conversation = {
    chatId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
  };

  // `/new` is an explicit "start a fresh task" signal. In a plain chat (or an
  // existing topic), the next message after completion would otherwise resume
  // the previous snapshot. This command skips that resume path and, when
  // topics are available, creates a new task topic.
  const newTaskCommand = getTelegramNewTaskCommand(update, {
    botUsername: botUsername ?? undefined,
  });

  if (!queuedMessage && !newTaskCommand) {
    return c.json({ ok: true, ignored: 'unsupported_update' });
  }

  if (
    queuedMessage &&
    !newTaskCommand &&
    (await handleTelegramRoutingReply({
      launchOwnerUserId: senderUserId,
      queuedMessage,
      metadata,
    }))
  ) {
    return c.json({
      ok: true,
      queued: false,
      routingReplyHandled: true,
    });
  }

  const repliedToReportRootId =
    message.reply_to_message &&
    typeof message.reply_to_message === 'object' &&
    'message_id' in message.reply_to_message
      ? message.reply_to_message.message_id
      : undefined;
  const repliedToAutomationReport = repliedToReportRootId
    ? await findTelegramAutomationReportRun({
        chatId: metadata.communicationChannelId,
        messageId: String(repliedToReportRootId),
      })
    : null;
  const activeRun = repliedToAutomationReport
    ? activeRunStatuses.some(
        (status) => status === repliedToAutomationReport.status,
      )
      ? repliedToAutomationReport
      : undefined
    : await findActiveTelegramTaskRun(conversation);

  if (activeRun && newTaskCommand) {
    const commandLabel = `/${newTaskCommand.command}`;

    await postTelegramMessageBestEffort({
      chatId: metadata.communicationChannelId,
      threadId: metadata.communicationThreadId,
      replyToMessageId: metadata.communicationMessageId,
      text: newTaskCommand.text
        ? `A task is already running in this chat, so ${commandLabel} did not start a new one. Cancel it first (✖️ Cancel task) or wait for it to finish, then resend it:\n\n${commandLabel} ${newTaskCommand.text}`
        : `A task is already running in this chat. Cancel it first (✖️ Cancel task) or wait for it to finish, then send ${commandLabel} <your request>.`,
    });

    return c.json({ ok: true, queued: false, repliedInline: true });
  }

  if (activeRun) {
    if (!queuedMessage) {
      return c.json({ ok: true, ignored: 'unsupported_update' });
    }

    // Prefer structured request_user_input answers over plain¡ follow-ups.
    if (queuedMessage.userId && queuedMessage.text?.trim()) {
      const { tryHandleTelegramRequestUserInputMessage } =
        await import('./request-user-input.js');
      const handled = await tryHandleTelegramRequestUserInputMessage({
        activeRunId: activeRun.id,
        userId: queuedMessage.userId,
        text: queuedMessage.text,
        chatId: metadata.communicationChannelId,
        threadId: metadata.communicationThreadId,
      });
      if (handled) {
        await ackTelegramMessageBestEffort({
          chatId: metadata.communicationChannelId,
          messageId: metadata.communicationMessageId,
        }).catch(() => undefined);
        return c.json({
          ok: true,
          queued: true,
          runId: activeRun.id,
          requestUserInput: true,
        });
      }
    }

    // Trusted pre-queue actor switch; see acting-user-sync.ts. The worker
    // only runs the queued turn as this sender if the server actor matches.
    await syncActingUserForInboundMessage({
      logContext: 'telegram.activeRunMessage',
      runId: activeRun.id,
      senderUserId: queuedMessage.userId,
    });
    await queueCommunicationMessage('telegram', activeRun.id, queuedMessage);
    // A typed reply supersedes any pending PR review offers in the chat.
    retireTelegramPrReviewOffersBestEffort({
      chatId: conversation.chatId,
      threadId: conversation.threadId ?? null,
    });
    // Track the latest inbound user message id so later outbound replies quote
    // the most recent user message instead of the original launch message.
    await setLatestInboundMessageId(
      'telegram',
      activeRun.id,
      metadata.communicationMessageId ?? queuedMessage.ts,
    ).catch((error) => {
      apiLogger.warn(
        `[telegram] Failed to track latest inbound message id for task run ${activeRun.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    await ackTelegramMessageBestEffort({
      chatId: metadata.communicationChannelId,
      messageId: metadata.communicationMessageId,
    });

    apiLogger.debug(
      `[telegram] Queued Telegram message ${queuedMessage.ts} for task run ${activeRun.id}`,
    );

    return c.json({ ok: true, queued: true, runId: activeRun.id });
  }

  if (newTaskCommand && !newTaskCommand.text) {
    await postTelegramMessageBestEffort({
      chatId: metadata.communicationChannelId,
      threadId: metadata.communicationThreadId,
      replyToMessageId: metadata.communicationMessageId,
      text: `Send your request after the command — for example, \`/${newTaskCommand.command} fix the flaky auth test\`.`,
      textFormat: 'markdown',
    });

    return c.json({ ok: true, queued: false, repliedInline: true });
  }

  if (!queuedMessage) {
    return c.json({ ok: true, ignored: 'unsupported_update' });
  }

  const isTaskEntry =
    isTelegramTaskEntryUpdate(update, {
      botUsername: botUsername ?? undefined,
    }) || Boolean(repliedToAutomationReport);
  // Only task-owned topics are explicit Roomote conversations. A user-owned
  // forum topic still requires a group @mention before an old task resumes.
  const completedRunCandidate = repliedToAutomationReport
    ? repliedToAutomationReport.status === RunStatus.Completed &&
      repliedToAutomationReport.snapshotId &&
      isSnapshotResumable(repliedToAutomationReport.snapshotCreatedAt)
      ? repliedToAutomationReport
      : null
    : !newTaskCommand && (isTaskEntry || metadata.communicationThreadId)
      ? await findCompletedTelegramTaskRunWithSnapshot(conversation)
      : null;
  const completedRun =
    completedRunCandidate &&
    (isTaskEntry || completedRunCandidate.payload.telegramTaskTopic === true)
      ? completedRunCandidate
      : null;

  if (!newTaskCommand && !isTaskEntry && !completedRun) {
    apiLogger.debug(
      `[telegram] Ignoring Telegram message without active task run or task entry signal for chat ${metadata.communicationChannelId} thread ${metadata.communicationThreadId ?? 'unknown'}`,
    );

    return c.json({ ok: true, queued: false, reason: 'not_task_entry' });
  }

  if (newTaskCommand) {
    // The command detection already isolated the request text; use it as the
    // task description instead of the generically stripped message text.
    queuedMessage.text = newTaskCommand.text;
  }

  // Ack before routing so the sender sees pickup while the router runs.
  await ackTelegramMessageBestEffort({
    chatId: metadata.communicationChannelId,
    messageId: metadata.communicationMessageId,
  });

  if (completedRun) {
    try {
      const resumeLaunch = await resumeTelegramTaskFromSnapshot({
        completedRun,
        queuedMessage,
        metadata,
      });

      // A typed reply supersedes any pending PR review offers in the chat.
      retireTelegramPrReviewOffersBestEffort({
        chatId: conversation.chatId,
        threadId: conversation.threadId ?? null,
      });

      await replyToTelegramSnapshotResume({
        launchResult: resumeLaunch,
        conversation: {
          ...conversation,
          replyToMessageId: metadata.communicationMessageId,
        },
      });

      return c.json({
        ok: true,
        resumed: true,
        runId: resumeLaunch.id,
      });
    } catch (error) {
      if (isDeploymentReadOnlyError(error)) {
        await postTelegramMessageBestEffort({
          chatId: metadata.communicationChannelId,
          threadId: metadata.communicationThreadId,
          replyToMessageId: metadata.communicationMessageId,
          text: MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
        });

        return c.json({
          ok: true,
          queued: false,
          repliedInline: true,
        });
      }

      apiLogger.warn(
        `[telegram] Failed to resume Telegram task from snapshot for chat ${metadata.communicationChannelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  let launch: Awaited<ReturnType<typeof startNewTelegramTask>>;
  try {
    launch = await startNewTelegramTask({
      message,
      launchOwnerUserId: senderUserId,
      queuedMessage,
      metadata,
      forceNewTopic: Boolean(newTaskCommand),
    });
  } catch (error) {
    if (isDeploymentReadOnlyError(error)) {
      await postTelegramMessageBestEffort({
        chatId: metadata.communicationChannelId,
        threadId: metadata.communicationThreadId,
        replyToMessageId: metadata.communicationMessageId,
        text: MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
      });

      return c.json({
        ok: true,
        queued: false,
        repliedInline: true,
      });
    }

    throw error;
  }

  if (launch.status === 'replied_inline') {
    return c.json({
      ok: true,
      queued: false,
      repliedInline: true,
    });
  }

  if (launch.status === 'confirmation_pending') {
    return c.json({
      ok: true,
      queued: false,
      confirmationPending: true,
    });
  }

  return c.json({
    ok: true,
    started: true,
    runId: launch.launchResult.id,
  });
});
