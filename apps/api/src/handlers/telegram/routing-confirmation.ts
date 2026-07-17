import { randomBytes } from 'node:crypto';

import type {
  TelegramCallbackQuery,
  TelegramUpdateCommunicationMetadata,
} from '@roomote/communication/telegram-update';
import type { CommunicationMessageButton } from '@roomote/communication';
import { getRedis } from '@roomote/redis';
import {
  getAvailableEnvironments,
  getRoutingAutoConfirmDelayMs,
  type RoutingDecision,
  type RoutingContext,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';

import { apiLogger } from '../../logging.js';
import { resolveRoutingFollowUp } from '../tasks/routing-follow-up.js';
import {
  buildTelegramRouteAltCallbackData,
  buildTelegramRouteNoCallbackData,
  buildTelegramRouteOkCallbackData,
  buildTelegramRoutePickCallbackData,
  type TelegramRouteCallbackAction,
} from './callback-data.js';
import { resolveTelegramSenderUserId } from './linked-user.js';
import {
  ackTelegramMessageBestEffort,
  answerTelegramCallbackQueryBestEffort,
  clearTelegramMessageButtonsBestEffort,
  editTelegramMessageBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';
import { launchTelegramTask, resolveTelegramWorkspace } from './task-launch.js';
import type { QueuedTelegramCommunicationMessage } from './types.js';

/** Pickers have no auto-start, so give the user a while to choose. */
const PENDING_ROUTE_TTL_SECONDS = 15 * 60;

const PENDING_ROUTE_KEY_PREFIX = 'telegram:pending_route:';
const PENDING_ROUTE_POINTER_KEY_PREFIX = 'telegram:pending_route_ptr:';

/** Inline keyboards get unwieldy past a handful of rows. */
const MAX_ENVIRONMENT_OPTIONS = 5;

const MAX_OPTION_LABEL_LENGTH = 48;

type PendingTelegramRouteOption = {
  label: string;
  workspace: RoutingWorkspace;
};

type PendingTelegramRoute = {
  launchOwnerUserId: string;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
  routingContext?: RoutingContext;
  createTopicForTask?: boolean;
  options: PendingTelegramRouteOption[];
  /**
   * Index into `options` of the router's suggestion. Null once the card is
   * in picker mode (after Nope, or on router fallback) — never auto-starts.
   */
  suggestedIndex: number | null;
  confirmMessageId?: string;
};

function pendingRouteKey(pendingRouteId: string): string {
  return `${PENDING_ROUTE_KEY_PREFIX}${pendingRouteId}`;
}

function pendingRoutePointerKey(
  metadata: TelegramUpdateCommunicationMetadata,
): string {
  return `${PENDING_ROUTE_POINTER_KEY_PREFIX}${metadata.communicationChannelId}:${
    metadata.communicationThreadId ?? '-'
  }`;
}

function newPendingRouteId(): string {
  return randomBytes(9).toString('base64url');
}

function parsePendingRoute(raw: string | null): PendingTelegramRoute | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as PendingTelegramRoute;
  } catch {
    return null;
  }
}

async function peekPendingTelegramRoute(
  pendingRouteId: string,
): Promise<PendingTelegramRoute | null> {
  const redis = getRedis();

  return parsePendingRoute(await redis.get(pendingRouteKey(pendingRouteId)));
}

/** One-shot claim: whichever of button click / auto-confirm timer runs first wins. */
async function claimPendingTelegramRoute(
  pendingRouteId: string,
): Promise<PendingTelegramRoute | null> {
  const redis = getRedis();
  const pending = parsePendingRoute(
    await redis.getdel(pendingRouteKey(pendingRouteId)),
  );

  if (
    pending &&
    (await redis.get(pendingRoutePointerKey(pending.metadata))) ===
      pendingRouteId
  ) {
    await redis.del(pendingRoutePointerKey(pending.metadata));
  }

  return pending;
}

async function storePendingTelegramRoute(
  pendingRouteId: string,
  pending: PendingTelegramRoute,
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    pendingRouteKey(pendingRouteId),
    JSON.stringify(pending),
    'EX',
    PENDING_ROUTE_TTL_SECONDS,
  );
  await redis.set(
    pendingRoutePointerKey(pending.metadata),
    pendingRouteId,
    'EX',
    PENDING_ROUTE_TTL_SECONDS,
  );
}

function truncateLabel(label: string): string {
  return label.length > MAX_OPTION_LABEL_LENGTH
    ? `${label.slice(0, MAX_OPTION_LABEL_LENGTH - 1)}…`
    : label;
}

async function buildWorkspaceOptions(
  suggested: RoutingWorkspace | null,
): Promise<{
  options: PendingTelegramRouteOption[];
  suggestedIndex: number | null;
}> {
  const environments = await getAvailableEnvironments();
  const suggestedEnvironmentId =
    suggested?.type === 'environment' ? suggested.id : null;

  const environmentOptions = environments
    // The suggested environment always keeps its slot at the front.
    .sort((left, right) =>
      left.id === suggestedEnvironmentId
        ? -1
        : right.id === suggestedEnvironmentId
          ? 1
          : left.name.localeCompare(right.name),
    )
    .slice(0, MAX_ENVIRONMENT_OPTIONS)
    .map<PendingTelegramRouteOption>((environment) => ({
      label: truncateLabel(environment.name),
      workspace: {
        type: 'environment',
        id: environment.id,
        name: environment.name,
      },
    }));

  const options: PendingTelegramRouteOption[] = [
    ...environmentOptions,
    { label: 'All repositories', workspace: { type: 'all_repositories' } },
  ];

  const suggestedIndex =
    suggested === null
      ? null
      : options.findIndex((option) =>
          suggested.type === 'all_repositories'
            ? option.workspace.type === 'all_repositories'
            : option.workspace.type === 'environment' &&
              option.workspace.id === suggested.id,
        );

  return {
    options,
    suggestedIndex:
      suggestedIndex === null || suggestedIndex < 0 ? null : suggestedIndex,
  };
}

/** The compact Yes/Nope row shown while the suggestion is pending. */
function buildConfirmButtons(
  pendingRouteId: string,
): CommunicationMessageButton[][] {
  return [
    [
      {
        text: '✅ Yes',
        callbackData: buildTelegramRouteOkCallbackData(pendingRouteId),
      },
      {
        text: '✖️ Nope',
        callbackData: buildTelegramRouteAltCallbackData(pendingRouteId),
      },
    ],
  ];
}

/** The full workspace list, shown after Nope or on router fallback. */
function buildPickerButtons(
  pendingRouteId: string,
  options: PendingTelegramRouteOption[],
): CommunicationMessageButton[][] {
  return [
    ...options.map((option, index) => [
      {
        text: option.label,
        callbackData: buildTelegramRoutePickCallbackData(pendingRouteId, index),
      },
    ]),
    [
      {
        text: '✖️ Never mind',
        callbackData: buildTelegramRouteNoCallbackData(pendingRouteId),
      },
    ],
  ];
}

const PICKER_TEXT = 'Okay — where should I run this?';

/** Swap the card into a terminal state: final text, keyboard removed. */
async function finalizeConfirmationCard(input: {
  chatId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  const edited = await editTelegramMessageBestEffort({
    chatId: input.chatId,
    messageId: input.messageId,
    text: input.text,
    textFormat: 'markdown',
  });

  if (!edited) {
    await clearTelegramMessageButtonsBestEffort({
      chatId: input.chatId,
      messageId: input.messageId,
    });
  }
}

/**
 * A superseding request in the same chat/topic invalidates the previous
 * pending card so two confirmations can never both launch.
 */
async function invalidatePreviousPendingRoute(
  metadata: TelegramUpdateCommunicationMetadata,
): Promise<void> {
  const redis = getRedis();
  const previousId = await redis.getdel(pendingRoutePointerKey(metadata));

  if (!previousId) {
    return;
  }

  const previous = parsePendingRoute(
    await redis.getdel(pendingRouteKey(previousId)),
  );

  if (previous?.confirmMessageId) {
    await clearTelegramMessageButtonsBestEffort({
      chatId: previous.metadata.communicationChannelId,
      messageId: previous.confirmMessageId,
    });
  }
}

function scheduleTelegramRoutingAutoConfirm(
  pendingRouteId: string,
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    autoConfirmTelegramRouting(pendingRouteId).catch((error) => {
      apiLogger.warn(
        `[telegram] Routing auto-confirm failed for ${pendingRouteId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, delayMs);

  // Like Slack's auto-confirm, the timer is in-process: a restart loses it
  // and the pending route simply expires with its Redis TTL.
  timer.unref?.();
}

async function autoConfirmTelegramRouting(
  pendingRouteId: string,
): Promise<void> {
  const pending = await claimPendingTelegramRoute(pendingRouteId);

  if (!pending || pending.suggestedIndex === null) {
    return;
  }

  const option = pending.options[pending.suggestedIndex];
  const workspace = option
    ? await resolveTelegramWorkspace(option.workspace)
    : null;

  if (!workspace) {
    if (pending.confirmMessageId) {
      await clearTelegramMessageButtonsBestEffort({
        chatId: pending.metadata.communicationChannelId,
        messageId: pending.confirmMessageId,
      });
    }
    await postTelegramMessageBestEffort({
      chatId: pending.metadata.communicationChannelId,
      threadId: pending.metadata.communicationThreadId,
      replyToMessageId: pending.metadata.communicationMessageId,
      text: 'Could not start the task — the suggested workspace is no longer available. Send the request again.',
    });
    return;
  }

  if (pending.confirmMessageId) {
    await finalizeConfirmationCard({
      chatId: pending.metadata.communicationChannelId,
      messageId: pending.confirmMessageId,
      text: `Starting in **${workspace.workspaceDisplayName}**.`,
    });
  }

  await launchTelegramTask({
    launchOwnerUserId: pending.launchOwnerUserId,
    queuedMessage: pending.queuedMessage,
    metadata: pending.metadata,
    workspace,
    createTopicForTask: pending.createTopicForTask,
  });
}

/**
 * Post a routing-confirmation card when the router was not confident (or
 * fell back entirely) and there is more than one workspace to choose from.
 *
 * Routed suggestions get a compact Yes/Nope card that auto-starts after the
 * shared correction window; Nope swaps the same message into a picker. Router
 * fallback shows the picker directly and never auto-starts.
 *
 * Returns null when the launch should proceed immediately instead: high
 * confidence, nothing to choose between, or the card could not be stored or
 * posted (the task must never be dropped because confirmation plumbing
 * failed).
 */
export async function maybeRequestTelegramRoutingConfirmation(input: {
  routingDecision: Exclude<RoutingDecision, { status: 'platform_answer' }>;
  routingContext: RoutingContext;
  launchOwnerUserId: string;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
  createTopicForTask?: boolean;
}): Promise<{ pendingRouteId: string } | null> {
  const routed =
    input.routingDecision.status === 'routed'
      ? input.routingDecision.result
      : null;
  const autoConfirmDelayMs = routed
    ? getRoutingAutoConfirmDelayMs(routed.debug, routed.workspace.type)
    : null;

  if (routed && autoConfirmDelayMs === 0) {
    return null;
  }

  try {
    const { options, suggestedIndex } = await buildWorkspaceOptions(
      routed?.workspace ?? null,
    );

    if (options.length <= 1) {
      return null;
    }

    const pendingRouteId = newPendingRouteId();
    const pending: PendingTelegramRoute = {
      launchOwnerUserId: input.launchOwnerUserId,
      queuedMessage: input.queuedMessage,
      metadata: input.metadata,
      routingContext: input.routingContext,
      createTopicForTask: input.createTopicForTask,
      options,
      suggestedIndex,
    };

    await invalidatePreviousPendingRoute(input.metadata);
    await storePendingTelegramRoute(pendingRouteId, pending);

    const suggestedLabel =
      suggestedIndex === null ? null : options[suggestedIndex]!.label;
    const posted = await postTelegramMessageBestEffort({
      chatId: input.metadata.communicationChannelId,
      threadId: input.metadata.communicationThreadId,
      replyToMessageId: input.metadata.communicationMessageId,
      text:
        suggestedLabel && autoConfirmDelayMs !== null
          ? `Planning to run this in **${suggestedLabel}** — starting in ~${Math.round(autoConfirmDelayMs / 1000)}s.`
          : 'I could not confidently pick a workspace for this request. Choose where to run it:',
      textFormat: 'markdown',
      buttons:
        suggestedIndex === null
          ? buildPickerButtons(pendingRouteId, options)
          : buildConfirmButtons(pendingRouteId),
    });

    if (!posted) {
      // The card never reached the chat, so nobody can click it — reclaim
      // the state and launch immediately.
      await claimPendingTelegramRoute(pendingRouteId);
      return null;
    }

    // Attach the card's message id (needed to finalize it later); XX so a
    // click that already claimed the state is not resurrected.
    const redis = getRedis();
    await redis.set(
      pendingRouteKey(pendingRouteId),
      JSON.stringify({ ...pending, confirmMessageId: posted.messageId }),
      'EX',
      PENDING_ROUTE_TTL_SECONDS,
      'XX',
    );

    if (suggestedIndex !== null && autoConfirmDelayMs !== null) {
      scheduleTelegramRoutingAutoConfirm(pendingRouteId, autoConfirmDelayMs);
    }

    return { pendingRouteId };
  } catch (error) {
    apiLogger.warn(
      `[telegram] Skipping routing confirmation (falling back to immediate launch): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * Nope: swap the Yes/Nope card into the workspace picker. The pending state
 * moves to a fresh id so the already-scheduled auto-confirm timer (which
 * claims the old id) can never launch the suggestion after the user said no.
 */
async function switchToWorkspacePicker(params: {
  query: TelegramCallbackQuery;
  chatId: string;
  messageId: string;
  claimed: PendingTelegramRoute;
}): Promise<void> {
  const nextId = newPendingRouteId();
  const nextPending: PendingTelegramRoute = {
    ...params.claimed,
    suggestedIndex: null,
    confirmMessageId: params.messageId,
  };

  await storePendingTelegramRoute(nextId, nextPending);

  const edited = await editTelegramMessageBestEffort({
    chatId: params.chatId,
    messageId: params.messageId,
    text: PICKER_TEXT,
    buttons: buildPickerButtons(nextId, nextPending.options),
  });

  if (!edited) {
    // Editing failed (deleted card, API hiccup) — post the picker as a new
    // message so the user is not stuck.
    const posted = await postTelegramMessageBestEffort({
      chatId: params.chatId,
      threadId: params.claimed.metadata.communicationThreadId,
      replyToMessageId: params.messageId,
      text: PICKER_TEXT,
      buttons: buildPickerButtons(nextId, nextPending.options),
    });

    if (posted) {
      const redis = getRedis();
      await redis.set(
        pendingRouteKey(nextId),
        JSON.stringify({ ...nextPending, confirmMessageId: posted.messageId }),
        'EX',
        PENDING_ROUTE_TTL_SECONDS,
        'XX',
      );
    }
  }

  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: params.query.id,
  });
}

async function launchPendingTelegramRoute(input: {
  pending: PendingTelegramRoute;
  option: PendingTelegramRouteOption;
}): Promise<void> {
  const workspace = await resolveTelegramWorkspace(input.option.workspace);

  if (!workspace) {
    throw new Error('The selected Telegram workspace is no longer available.');
  }

  await launchTelegramTask({
    launchOwnerUserId: input.pending.launchOwnerUserId,
    queuedMessage: input.pending.queuedMessage,
    metadata: input.pending.metadata,
    workspace,
    createTopicForTask: input.pending.createTopicForTask,
  });

  if (input.pending.confirmMessageId) {
    await finalizeConfirmationCard({
      chatId: input.pending.metadata.communicationChannelId,
      messageId: input.pending.confirmMessageId,
      text: `Starting in **${workspace.workspaceDisplayName}**.`,
    });
  }
}

/**
 * Treat a normal message sent while a routing card is pending as a response
 * to that card. This runs before normal task-entry and snapshot-resume logic,
 * so a correction never becomes a second task or replaces the original text.
 */
export async function handleTelegramRoutingReply(input: {
  launchOwnerUserId: string;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
}): Promise<boolean> {
  const redis = getRedis();
  const pendingRouteId = await redis.get(
    pendingRoutePointerKey(input.metadata),
  );

  if (!pendingRouteId) {
    return false;
  }

  const pending = await peekPendingTelegramRoute(pendingRouteId);

  if (
    !pending ||
    !pending.routingContext ||
    pending.launchOwnerUserId !== input.launchOwnerUserId ||
    pending.metadata.communicationChannelId !==
      input.metadata.communicationChannelId ||
    pending.metadata.communicationThreadId !==
      input.metadata.communicationThreadId
  ) {
    return false;
  }

  const claimed = await claimPendingTelegramRoute(pendingRouteId);

  if (!claimed) {
    return false;
  }

  await ackTelegramMessageBestEffort({
    chatId: input.metadata.communicationChannelId,
    messageId: input.metadata.communicationMessageId,
  });

  const suggestedOption =
    claimed.suggestedIndex === null
      ? null
      : (claimed.options[claimed.suggestedIndex] ?? null);

  try {
    const resolution = await resolveRoutingFollowUp({
      routingContext: claimed.routingContext!,
      suggestion: suggestedOption
        ? {
            workspace: suggestedOption.workspace,
            workspaceDisplayName: suggestedOption.label,
          }
        : null,
      userResponse: input.queuedMessage.text,
      userName: input.queuedMessage.user,
      userId: input.launchOwnerUserId,
    });

    if (resolution.intent === 'cancel') {
      if (claimed.confirmMessageId) {
        await finalizeConfirmationCard({
          chatId: claimed.metadata.communicationChannelId,
          messageId: claimed.confirmMessageId,
          text: 'Okay — not starting a task.',
        });
      }
      return true;
    }

    if (resolution.intent === 'confirm') {
      if (!suggestedOption) {
        throw new Error('A Telegram routing confirmation had no suggestion.');
      }
      await launchPendingTelegramRoute({
        pending: claimed,
        option: suggestedOption,
      });
      return true;
    }

    const routingDecision = resolution.routingDecision;

    if (routingDecision.status === 'platform_answer') {
      if (claimed.confirmMessageId) {
        await finalizeConfirmationCard({
          chatId: claimed.metadata.communicationChannelId,
          messageId: claimed.confirmMessageId,
          text: routingDecision.result.answer,
        });
      }
      return true;
    }

    const routed =
      routingDecision.status === 'routed' ? routingDecision.result : null;
    const { options, suggestedIndex } = await buildWorkspaceOptions(
      routed?.workspace ?? null,
    );
    const autoConfirmDelayMs = routed
      ? getRoutingAutoConfirmDelayMs(routed.debug, routed.workspace.type)
      : null;
    const nextSuggestedOption =
      suggestedIndex === null ? null : (options[suggestedIndex] ?? null);
    const nextPending: PendingTelegramRoute = {
      ...claimed,
      options,
      suggestedIndex,
    };

    if (
      nextSuggestedOption &&
      (options.length <= 1 || autoConfirmDelayMs === 0)
    ) {
      await launchPendingTelegramRoute({
        pending: nextPending,
        option: nextSuggestedOption,
      });
      return true;
    }

    const nextPendingRouteId = newPendingRouteId();
    await storePendingTelegramRoute(nextPendingRouteId, nextPending);

    const text =
      nextSuggestedOption && autoConfirmDelayMs !== null
        ? `Planning to run this in **${nextSuggestedOption.label}** — starting in ~${Math.round(autoConfirmDelayMs / 1000)}s.`
        : PICKER_TEXT;
    const buttons = nextSuggestedOption
      ? buildConfirmButtons(nextPendingRouteId)
      : buildPickerButtons(nextPendingRouteId, options);
    const edited = claimed.confirmMessageId
      ? await editTelegramMessageBestEffort({
          chatId: claimed.metadata.communicationChannelId,
          messageId: claimed.confirmMessageId,
          text,
          textFormat: 'markdown',
          buttons,
        })
      : null;

    if (!edited) {
      const posted = await postTelegramMessageBestEffort({
        chatId: claimed.metadata.communicationChannelId,
        threadId: claimed.metadata.communicationThreadId,
        replyToMessageId: input.metadata.communicationMessageId,
        text,
        textFormat: 'markdown',
        buttons,
      });

      if (!posted) {
        await claimPendingTelegramRoute(nextPendingRouteId);
        throw new Error('Could not update the Telegram routing card.');
      }

      nextPending.confirmMessageId = posted.messageId;
      await storePendingTelegramRoute(nextPendingRouteId, nextPending);
    }

    if (nextSuggestedOption && autoConfirmDelayMs !== null) {
      scheduleTelegramRoutingAutoConfirm(
        nextPendingRouteId,
        autoConfirmDelayMs,
      );
    }

    return true;
  } catch (error) {
    await storePendingTelegramRoute(pendingRouteId, claimed).catch(
      () => undefined,
    );
    throw error;
  }
}

/** Handle a click on one of the routing-confirmation buttons. */
export async function handleTelegramRoutingCallback(params: {
  query: TelegramCallbackQuery;
  action: TelegramRouteCallbackAction;
}): Promise<void> {
  const { query, action } = params;
  const message = query.message;
  const chatId = message ? String(message.chat.id) : null;

  if (!chatId || !message) {
    await answerTelegramCallbackQueryBestEffort({ callbackQueryId: query.id });
    return;
  }

  const pending = await peekPendingTelegramRoute(action.pendingRouteId);

  if (!pending || pending.metadata.communicationChannelId !== chatId) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'This choice expired — send the request again.',
    });
    await clearTelegramMessageButtonsBestEffort({
      chatId,
      messageId: String(message.message_id),
    });
    return;
  }

  const senderUserId = await resolveTelegramSenderUserId(String(query.from.id));

  // Peek-then-verify so a click from someone else cannot consume the
  // requester's pending choice.
  if (!senderUserId || senderUserId !== pending.launchOwnerUserId) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'Only the requester can choose a workspace for this task.',
    });
    return;
  }

  const optionIndex =
    action.action === 'ok'
      ? pending.suggestedIndex
      : action.action === 'pick'
        ? action.optionIndex
        : null;

  if (
    (action.action === 'ok' || action.action === 'pick') &&
    (optionIndex === null || optionIndex < 0)
  ) {
    await answerTelegramCallbackQueryBestEffort({ callbackQueryId: query.id });
    return;
  }

  const claimed = await claimPendingTelegramRoute(action.pendingRouteId);

  if (!claimed) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'This choice expired — send the request again.',
    });
    return;
  }

  if (action.action === 'alt') {
    await switchToWorkspacePicker({
      query,
      chatId,
      messageId: String(message.message_id),
      claimed,
    });
    return;
  }

  if (action.action === 'no') {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'Okay — not starting a task.',
    });
    await finalizeConfirmationCard({
      chatId,
      messageId: String(message.message_id),
      text: 'Okay — not starting a task.',
    });
    return;
  }

  const option = claimed.options[optionIndex!];
  const workspace = option
    ? await resolveTelegramWorkspace(option.workspace)
    : null;

  if (!workspace) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'That workspace is no longer available.',
    });
    await postTelegramMessageBestEffort({
      chatId,
      ...(message.message_thread_id !== undefined
        ? { threadId: String(message.message_thread_id) }
        : {}),
      replyToMessageId: String(message.message_id),
      text: 'Could not start the task — that workspace is no longer available. Send the request again.',
    });
    return;
  }

  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: query.id,
    text: `Starting in ${workspace.workspaceDisplayName}.`,
  });
  await finalizeConfirmationCard({
    chatId,
    messageId: String(message.message_id),
    text: `Starting in **${workspace.workspaceDisplayName}**.`,
  });

  try {
    await launchTelegramTask({
      launchOwnerUserId: claimed.launchOwnerUserId,
      queuedMessage: claimed.queuedMessage,
      metadata: claimed.metadata,
      workspace,
      createTopicForTask: claimed.createTopicForTask,
    });
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to launch task from routing confirmation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await postTelegramMessageBestEffort({
      chatId,
      ...(message.message_thread_id !== undefined
        ? { threadId: String(message.message_thread_id) }
        : {}),
      replyToMessageId: String(message.message_id),
      text: 'Could not start the task — send the request again.',
    });
  }
}
