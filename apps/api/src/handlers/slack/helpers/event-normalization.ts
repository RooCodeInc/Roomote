import type { SlackEvent, SlackFunctionExecutedEvent } from '@roomote/slack';
import type { SlackInstallation } from '@roomote/db/server';
import {
  appendSlackAttachmentContext,
  appendSlackForwardedMessageFiles,
  formatSlackAttachmentContext,
} from '@roomote/slack';

import { THUMBS_UP_REACTIONS } from '../constants.js';
import type {
  AutomatedSlackAppMentionEvent,
  SlackWebhookEvent,
} from '../types.js';
import {
  getMentionedSlackUserIds,
  mentionsSlackBot,
} from './mention-routing.js';

function normalizeSlackReactionName(reaction: string): string {
  return reaction.trim().toLowerCase().split('::')[0] ?? '';
}

export function isThumbsUpReaction(reaction: string): boolean {
  const normalizedReaction = normalizeSlackReactionName(reaction);
  return THUMBS_UP_REACTIONS.has(normalizedReaction);
}

function coerceSlackWorkflowInputToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of [
    'value',
    'text',
    'id',
    'channel_id',
    'channel',
    'user_id',
    'user',
    'message_ts',
    'ts',
    'thread_ts',
  ]) {
    const nested = coerceSlackWorkflowInputToString(record[key]);

    if (nested) {
      return nested;
    }
  }

  return undefined;
}

export function isUnknownRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getSlackWorkflowInputString(
  inputs: SlackFunctionExecutedEvent['inputs'],
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = coerceSlackWorkflowInputToString(inputs[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function getSlackEventStringField(
  event: SlackWebhookEvent,
  field: string,
): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function enrichSlackMessageEvent(event: SlackWebhookEvent): void {
  if (event.type !== 'app_mention' && event.type !== 'message') {
    return;
  }

  const slackEvent = event as SlackEvent;
  const rawText = getSlackEventStringField(event, 'text');
  const attachments =
    'attachments' in event && Array.isArray(event.attachments)
      ? event.attachments
      : undefined;
  const blocks =
    'blocks' in event && Array.isArray(event.blocks) ? event.blocks : undefined;
  const authoredText =
    typeof slackEvent.authoredText === 'string'
      ? slackEvent.authoredText
      : typeof rawText === 'string'
        ? rawText
        : '';

  slackEvent.authoredText = authoredText;
  slackEvent.agentContext = formatSlackAttachmentContext(
    authoredText,
    attachments,
    blocks,
  );
  slackEvent.text = appendSlackAttachmentContext(
    authoredText,
    attachments,
    blocks,
  );
  slackEvent.files = appendSlackForwardedMessageFiles(
    Array.isArray(slackEvent.files) ? slackEvent.files : undefined,
    attachments,
  );
}

export function isSlackFunctionExecutedEvent(
  event: SlackWebhookEvent,
): event is SlackFunctionExecutedEvent {
  return event.type === 'function_executed';
}

export function getSlackWebhookEventLogDetails(event: SlackWebhookEvent): {
  subtype: string;
  channel?: string;
  threadTs?: string;
  ts?: string;
  text?: string;
  user: string;
  callbackId?: string;
} {
  if (isSlackFunctionExecutedEvent(event)) {
    return {
      subtype: 'none',
      channel: getSlackWorkflowInputString(event.inputs, ['channel_id']),
      threadTs: getSlackWorkflowInputString(event.inputs, ['message_ts']),
      ts: event.event_ts,
      text: getSlackWorkflowInputString(event.inputs, ['prompt'])?.substring(
        0,
        100,
      ),
      user: 'n/a',
      callbackId: event.function.callback_id,
    };
  }

  return {
    channel:
      'channel' in event && typeof event.channel === 'string'
        ? event.channel
        : 'item' in event
          ? event.item.channel
          : undefined,
    subtype:
      'subtype' in event && typeof event.subtype === 'string'
        ? event.subtype
        : 'none',
    threadTs:
      'thread_ts' in event && typeof event.thread_ts === 'string'
        ? event.thread_ts
        : 'item' in event
          ? event.item.ts
          : undefined,
    ts:
      'ts' in event && typeof event.ts === 'string'
        ? event.ts
        : 'event_ts' in event
          ? event.event_ts
          : undefined,
    text:
      'text' in event && typeof event.text === 'string'
        ? event.text.substring(0, 100)
        : undefined,
    user:
      'user' in event && typeof event.user === 'string' ? event.user : 'n/a',
  };
}

export function isAppAuthoredSlackEvent(event: SlackWebhookEvent): boolean {
  return Boolean(getSlackEventStringField(event, 'app_id'));
}

export function isRoomoteAuthoredSlackEvent(
  event: SlackWebhookEvent,
  slackInstallation: SlackInstallation,
): boolean {
  const eventUser = getSlackEventStringField(event, 'user');
  const eventAppId = getSlackEventStringField(event, 'app_id');
  const eventBotId = getSlackEventStringField(event, 'bot_id');

  return (
    (Boolean(eventUser) && eventUser === slackInstallation.botUserId) ||
    (Boolean(eventAppId) && eventAppId === slackInstallation.appId) ||
    (Boolean(eventBotId) && eventBotId === slackInstallation.botUserId)
  );
}

// Automated (app/bot-authored) messages that mention users without mentioning
// the installed Roomote bot are discarded, which is invisible in logs and has
// hidden real misconfigurations — e.g. a Slack workflow whose message template
// still mentions the bot user of a previous Roomote installation. Surface a
// log line naming the mentioned IDs so those drops are diagnosable.
export function getIgnoredAutomatedSlackMentionLog(
  event: SlackWebhookEvent,
  slackInstallation: SlackInstallation,
): string | null {
  if (event.type !== 'message' && event.type !== 'app_mention') {
    return null;
  }

  if (isRoomoteAuthoredSlackEvent(event, slackInstallation)) {
    return null;
  }

  const slackEvent = event as SlackEvent;
  const mentionedUserIds = getMentionedSlackUserIds(slackEvent);

  if (
    mentionedUserIds.length === 0 ||
    (slackInstallation.botUserId &&
      mentionedUserIds.includes(slackInstallation.botUserId))
  ) {
    return null;
  }

  const subtype = getSlackEventStringField(event, 'subtype') ?? 'none';
  const appId = getSlackEventStringField(event, 'app_id') ?? 'none';
  const botId = getSlackEventStringField(event, 'bot_id') ?? 'none';

  return (
    `[SlackWebhook] Ignoring automated message mentioning [${mentionedUserIds.join(', ')}] ` +
    `but not the Roomote bot user ${slackInstallation.botUserId} ` +
    `(channel=${slackEvent.channel}, ts=${slackEvent.ts}, thread_ts=${slackEvent.thread_ts ?? 'none'}, ` +
    `subtype=${subtype}, app_id=${appId}, bot_id=${botId})`
  );
}

export function isRoutableAutomatedSlackAppMention(
  event: SlackWebhookEvent,
  slackInstallation: SlackInstallation,
): event is AutomatedSlackAppMentionEvent {
  const isAppMention = event.type === 'app_mention';
  const isBotMessageMention =
    event.type === 'message' &&
    getSlackEventStringField(event, 'subtype') === 'bot_message' &&
    mentionsSlackBot(event, slackInstallation.botUserId);

  if (
    (!isAppMention && !isBotMessageMention) ||
    !isAppAuthoredSlackEvent(event) ||
    isRoomoteAuthoredSlackEvent(event, slackInstallation)
  ) {
    return false;
  }

  return Boolean(
    getSlackEventStringField(event, 'channel') &&
    getSlackEventStringField(event, 'text') &&
    getSlackEventStringField(event, 'ts'),
  );
}
