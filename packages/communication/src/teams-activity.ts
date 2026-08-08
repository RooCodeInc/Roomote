import { z } from 'zod';

import type { QueuedCommunicationMessage } from '@roomote/types';

import {
  inferPromptImageMimeTypeFromName,
  isGenericImageMimeType,
  normalizePromptImageMimeType,
} from './teams-image-mime';

const teamsActivityAccountSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    aadObjectId: z.string().optional(),
  })
  .passthrough();

const teamsActivityChannelDataSchema = z
  .object({
    tenant: z
      .object({
        id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    team: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    channel: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const teamsActivityMentionEntitySchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    mentioned: teamsActivityAccountSchema.optional(),
  })
  .passthrough();

export const teamsActivitySchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    timestamp: z.string().optional(),
    serviceUrl: z.string().optional(),
    channelId: z.string().optional(),
    text: z.string().optional(),
    textFormat: z.string().optional(),
    from: teamsActivityAccountSchema.optional(),
    recipient: teamsActivityAccountSchema.optional(),
    conversation: z
      .object({
        id: z.string(),
        conversationType: z.string().optional(),
        tenantId: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough(),
    channelData: teamsActivityChannelDataSchema.optional(),
    entities: z.array(teamsActivityMentionEntitySchema).optional(),
    replyToId: z.string().optional(),
    reactionsAdded: z
      .array(
        z
          .object({
            type: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    attachments: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type TeamsActivity = z.infer<typeof teamsActivitySchema>;

const TEAMS_NATIVE_REACTION_TYPES = new Set([
  'like',
  'heart',
  'laugh',
  'surprised',
  'sad',
  'angry',
]);

export function isTeamsNativeReactionType(value: string): boolean {
  return TEAMS_NATIVE_REACTION_TYPES.has(value.trim().toLowerCase());
}

export type TeamsActivityCommunicationMetadata = {
  communicationProvider: 'teams';
  communicationTeamId?: string;
  communicationServiceUrl?: string;
  communicationChannelId: string;
  communicationThreadId?: string;
  communicationMessageId?: string;
  teamsTenantId?: string;
  teamsTeamId?: string;
  teamsChannelId?: string;
  teamsConversationId: string;
  teamsThreadId?: string;
  teamsMessageId?: string;
  teamsServiceUrl?: string;
};

export type TeamsActivityImageAttachment = {
  contentUrl: string;
  contentType: string;
  name?: string;
};

export type TeamsActivityAudioAttachment = {
  contentUrl: string;
  contentType?: string;
  name?: string;
};

const TEAMS_IMAGE_ATTACHMENT_TEXT = 'Image attachment';
const TEAMS_AUDIO_ATTACHMENT_TEXT = 'Audio attachment';

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const rawValue = value[key];

  return typeof rawValue === 'string'
    ? cleanOptionalString(rawValue)
    : undefined;
}

function inferPromptImageMimeTypeFromFileType(
  fileType: string | undefined,
): string | undefined {
  const normalized = cleanOptionalString(fileType)?.replace(/^\./, '');

  return normalized
    ? inferPromptImageMimeTypeFromName(`attachment.${normalized}`)
    : undefined;
}

export function parseTeamsActivity(input: unknown) {
  return teamsActivitySchema.safeParse(input);
}

export function isTeamsMessageActivity(activity: TeamsActivity): boolean {
  return activity.type === 'message';
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  return cleanOptionalString(value)?.toLowerCase();
}

const TEAMS_MENTION_TAG_PATTERN = /<at\b[^>]*>([^<]*)<\/at>/gi;

function normalizeTeamsText(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function replaceAllLiteral(input: string, search: string, replacement: string) {
  return search ? input.split(search).join(replacement) : input;
}

function replaceRemainingMentionTags(text: string): string {
  return text.replace(TEAMS_MENTION_TAG_PATTERN, (_match, mentionText) => {
    const normalizedMention = normalizeTeamsText(String(mentionText));

    return normalizedMention ? `@${normalizedMention}` : '';
  });
}

function removeLeadingMentionTag(text: string): string {
  return text.replace(/^\s*<at\b[^>]*>[^<]*<\/at>(?:&nbsp;|\s)*/i, '');
}

function isMentionForRecipient(
  mention: z.infer<typeof teamsActivityMentionEntitySchema>,
  activity: TeamsActivity,
): boolean {
  const recipientId = normalizeIdentifier(activity.recipient?.id);
  const recipientName = normalizeIdentifier(activity.recipient?.name);
  const mentionedId = normalizeIdentifier(mention.mentioned?.id);
  const mentionedName = normalizeIdentifier(mention.mentioned?.name);

  return Boolean(
    (recipientId && mentionedId === recipientId) ||
    (recipientName && mentionedName === recipientName),
  );
}

function removeMentionTagsByName(text: string, names: string[]): string {
  const normalizedNames = new Set(
    names.map((name) => normalizeIdentifier(name)).filter(Boolean),
  );

  if (normalizedNames.size === 0) {
    return text;
  }

  return text.replace(TEAMS_MENTION_TAG_PATTERN, (match, mentionText) => {
    const normalizedMention = normalizeIdentifier(String(mentionText));

    return normalizedMention && normalizedNames.has(normalizedMention)
      ? ''
      : match;
  });
}

export function stripTeamsBotMentions(
  text: string,
  activity?: TeamsActivity,
): string {
  if (!activity) {
    return normalizeTeamsText(text.replace(TEAMS_MENTION_TAG_PATTERN, ''));
  }

  const mentionEntities =
    activity.entities?.filter(
      (entity) => entity.type?.toLowerCase() === 'mention',
    ) ?? [];
  const botMentionEntities = mentionEntities.filter((entity) =>
    isMentionForRecipient(entity, activity),
  );
  const hasRecipientIdentity = Boolean(
    normalizeIdentifier(activity.recipient?.id) ||
    normalizeIdentifier(activity.recipient?.name),
  );
  const mentionsToRemove =
    botMentionEntities.length > 0
      ? botMentionEntities
      : hasRecipientIdentity
        ? []
        : mentionEntities.slice(0, 1);
  let result = text;

  for (const mention of mentionsToRemove) {
    if (mention.text) {
      result = replaceAllLiteral(result, mention.text, '');
    }
  }

  if (!hasRecipientIdentity && mentionEntities.length === 0) {
    result = removeLeadingMentionTag(result);
  }

  result = removeMentionTagsByName(
    result,
    mentionsToRemove
      .map((mention) => mention.mentioned?.name)
      .filter((name): name is string => Boolean(name)),
  );

  return normalizeTeamsText(replaceRemainingMentionTags(result));
}

export function isTeamsPersonalConversation(activity: TeamsActivity): boolean {
  return activity.conversation.conversationType?.toLowerCase() === 'personal';
}

function isTeamsChannelConversation(activity: TeamsActivity): boolean {
  return (
    activity.conversation.conversationType?.toLowerCase() === 'channel' ||
    Boolean(getTeamsActivityChannelId(activity))
  );
}

export function isTeamsBotMentioned(activity: TeamsActivity): boolean {
  const text = activity.text ?? '';
  const recipientId = normalizeIdentifier(activity.recipient?.id);
  const recipientName = normalizeIdentifier(activity.recipient?.name);
  const mentionEntities =
    activity.entities?.filter(
      (entity) => entity.type?.toLowerCase() === 'mention',
    ) ?? [];

  if (mentionEntities.length > 0) {
    for (const entity of mentionEntities) {
      const mentionedId = normalizeIdentifier(entity.mentioned?.id);
      const mentionedName = normalizeIdentifier(entity.mentioned?.name);

      if (
        (recipientId && mentionedId === recipientId) ||
        (recipientName && mentionedName === recipientName)
      ) {
        return true;
      }
    }

    if (!recipientId && !recipientName) {
      return mentionEntities.some((entity) =>
        /<at\b[^>]*>[^<]*<\/at>/i.test(entity.text ?? ''),
      );
    }
  }

  return /<at\b[^>]*>[^<]*<\/at>/i.test(text);
}

export function isTeamsTaskEntryActivity(activity: TeamsActivity): boolean {
  return (
    isTeamsMessageActivity(activity) &&
    (isTeamsPersonalConversation(activity) || isTeamsBotMentioned(activity))
  );
}

/**
 * True when the activity carries a mention entity that does not target the
 * bot (the activity recipient). When the recipient identity is missing every
 * mention counts as "somebody else" on purpose, so ambiguous mentions keep
 * the explicit-mention requirement.
 */
export function teamsActivityMentionsUserOtherThanBot(
  activity: TeamsActivity,
): boolean {
  const mentionEntities =
    activity.entities?.filter(
      (entity) => entity.type?.toLowerCase() === 'mention',
    ) ?? [];

  return mentionEntities.some(
    (entity) => !isMentionForRecipient(entity, activity),
  );
}

export function getTeamsActivityTenantId(
  activity: TeamsActivity,
): string | undefined {
  return cleanOptionalString(
    activity.channelData?.tenant?.id ?? activity.conversation.tenantId,
  );
}

export function getTeamsActivityTeamId(
  activity: TeamsActivity,
): string | undefined {
  return cleanOptionalString(activity.channelData?.team?.id);
}

export function getTeamsActivityChannelId(
  activity: TeamsActivity,
): string | undefined {
  return cleanOptionalString(activity.channelData?.channel?.id);
}

export function getTeamsActivityConversationId(
  activity: TeamsActivity,
): string {
  return activity.conversation.id;
}

export function getTeamsConversationMessageIdSuffix(
  conversationId: string,
): string | undefined {
  const separatorIndex = conversationId.indexOf(';messageid=');

  if (separatorIndex === -1) {
    return undefined;
  }

  return cleanOptionalString(
    conversationId.slice(separatorIndex + ';messageid='.length),
  );
}

export function getTeamsActivityThreadId(
  activity: TeamsActivity,
): string | undefined {
  const conversationThreadId = getTeamsConversationMessageIdSuffix(
    activity.conversation.id,
  );

  if (conversationThreadId) {
    return conversationThreadId;
  }

  const replyToId = cleanOptionalString(activity.replyToId);

  if (replyToId) {
    return replyToId;
  }

  return isTeamsChannelConversation(activity)
    ? cleanOptionalString(activity.id)
    : undefined;
}

export function isTeamsBotAuthoredActivity(
  activity: TeamsActivity,
  options: { botAppId?: string } = {},
): boolean {
  const fromId = normalizeIdentifier(activity.from?.id);
  const fromRole =
    activity.from && typeof activity.from.role === 'string'
      ? normalizeIdentifier(activity.from.role)
      : undefined;

  if (fromRole === 'bot') {
    return true;
  }

  if (!fromId) {
    return false;
  }

  const recipientId = normalizeIdentifier(activity.recipient?.id);
  const botAppId = normalizeIdentifier(options.botAppId);

  return Boolean(
    (recipientId && fromId === recipientId) ||
    fromId.startsWith('28:') ||
    (botAppId &&
      (fromId === botAppId ||
        fromId === `28:${botAppId}` ||
        fromId.endsWith(`:${botAppId}`))),
  );
}

export function getTeamsActivityCommunicationMetadata(
  activity: TeamsActivity,
): TeamsActivityCommunicationMetadata {
  const tenantId = getTeamsActivityTenantId(activity);
  const teamId = getTeamsActivityTeamId(activity);
  const teamsChannelId = getTeamsActivityChannelId(activity);
  const conversationId = getTeamsActivityConversationId(activity);
  const threadId = getTeamsActivityThreadId(activity);
  const messageId = cleanOptionalString(activity.id);
  const serviceUrl = cleanOptionalString(activity.serviceUrl);
  const metadata: TeamsActivityCommunicationMetadata = {
    communicationProvider: 'teams',
    communicationChannelId: conversationId,
    teamsConversationId: conversationId,
  };

  if (teamId ?? tenantId) {
    metadata.communicationTeamId = teamId ?? tenantId;
  }

  if (serviceUrl) {
    metadata.communicationServiceUrl = serviceUrl;
    metadata.teamsServiceUrl = serviceUrl;
  }

  if (threadId) {
    metadata.communicationThreadId = threadId;
    metadata.teamsThreadId = threadId;
  }

  if (messageId) {
    metadata.communicationMessageId = messageId;
    metadata.teamsMessageId = messageId;
  }

  if (tenantId) {
    metadata.teamsTenantId = tenantId;
  }

  if (teamId) {
    metadata.teamsTeamId = teamId;
  }

  if (teamsChannelId) {
    metadata.teamsChannelId = teamsChannelId;
  }

  return metadata;
}

export function teamsActivityToQueuedCommunicationMessage(
  activity: TeamsActivity,
  options: { userId?: string } = {},
): QueuedCommunicationMessage | null {
  if (!isTeamsMessageActivity(activity)) {
    return null;
  }

  const activityId = cleanOptionalString(activity.id);
  const text = stripTeamsBotMentions(activity.text ?? '', activity);
  const imageAttachments = getTeamsActivityImageAttachments(activity);
  const audioAttachments = getTeamsActivityAudioAttachments(activity);

  if (
    !activityId ||
    (!text && imageAttachments.length === 0 && audioAttachments.length === 0)
  ) {
    return null;
  }

  return {
    provider: 'teams',
    text:
      text ||
      (imageAttachments.length
        ? TEAMS_IMAGE_ATTACHMENT_TEXT
        : TEAMS_AUDIO_ATTACHMENT_TEXT),
    user: activity.from?.name ?? activity.from?.id ?? 'Teams user',
    ...(options.userId ? { userId: options.userId } : {}),
    ts: activityId,
    channel: getTeamsActivityConversationId(activity),
    ...(getTeamsActivityThreadId(activity)
      ? { threadTs: getTeamsActivityThreadId(activity) }
      : {}),
  };
}

export function getTeamsActivityImageAttachments(
  activity: TeamsActivity,
): TeamsActivityImageAttachment[] {
  const attachments: TeamsActivityImageAttachment[] = [];

  for (const rawAttachment of activity.attachments ?? []) {
    const attachment = readRecord(rawAttachment);

    if (!attachment) {
      continue;
    }

    const content = readRecord(attachment.content);
    const name = readString(attachment, 'name');
    const attachmentContentType = readString(attachment, 'contentType');
    const contentFileType = content
      ? readString(content, 'fileType')
      : undefined;
    const contentType =
      normalizePromptImageMimeType(attachmentContentType) ??
      inferPromptImageMimeTypeFromName(name) ??
      normalizePromptImageMimeType(
        content ? readString(content, 'contentType') : undefined,
      ) ??
      inferPromptImageMimeTypeFromFileType(contentFileType) ??
      (isGenericImageMimeType(attachmentContentType) ? 'image/*' : undefined);
    const contentUrl =
      readString(attachment, 'contentUrl') ??
      readString(attachment, 'thumbnailUrl') ??
      (content ? readString(content, 'downloadUrl') : undefined) ??
      (content ? readString(content, 'contentUrl') : undefined) ??
      (content ? readString(content, 'url') : undefined);

    if (!contentUrl || !contentType) {
      continue;
    }

    attachments.push({
      contentUrl,
      contentType,
      ...(name ? { name } : {}),
    });
  }

  return attachments;
}

export function getTeamsActivityAudioAttachments(
  activity: TeamsActivity,
): TeamsActivityAudioAttachment[] {
  const attachments: TeamsActivityAudioAttachment[] = [];

  for (const rawAttachment of activity.attachments ?? []) {
    const attachment = readRecord(rawAttachment);
    if (!attachment) continue;

    const content = readRecord(attachment.content);
    const name = readString(attachment, 'name');
    const contentType =
      readString(attachment, 'contentType') ??
      (content ? readString(content, 'contentType') : undefined);
    const contentUrl =
      readString(attachment, 'contentUrl') ??
      (content ? readString(content, 'downloadUrl') : undefined) ??
      (content ? readString(content, 'contentUrl') : undefined) ??
      (content ? readString(content, 'url') : undefined);
    const isAudio =
      contentType?.toLowerCase().startsWith('audio/') === true ||
      /\.(?:aac|flac|m4a|mp3|mp4|oga|ogg|opus|wav|webm)$/iu.test(name ?? '');

    if (!contentUrl || !isAudio) continue;
    attachments.push({
      contentUrl,
      ...(contentType ? { contentType } : {}),
      ...(name ? { name } : {}),
    });
  }

  return attachments;
}
