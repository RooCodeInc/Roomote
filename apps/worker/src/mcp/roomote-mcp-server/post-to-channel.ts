import { postToChannel } from './slack-api-client.js';
import {
  errorResultWithArtifacts,
  normalizeOptionalText,
  normalizeOptionalSlackText,
  uniqueNonEmpty,
  uploadSlackImagePaths,
  validateSlackPostContent,
} from './slack-post-helpers.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { ArtifactConfig, RoomoteConfig, ToolResult } from './types.js';

const CHANNEL_TARGET_ERROR =
  'channel must be a Slack channel ID/name/mention, DM ID, or Slack user ID/mention';
const SLACK_CHANNEL_ID_REGEX = /^[CG][A-Z0-9]{8,}$/i;
const SLACK_DIRECT_MESSAGE_ID_REGEX = /^D[A-Z0-9]{8,}$/i;
const SLACK_USER_ID_REGEX = /^U[A-Z0-9]{8,}$/i;
const SLACK_CHANNEL_MENTION_REGEX = /^<#([A-Z0-9]{9,})(?:\|[^>]+)?>$/i;
const SLACK_USER_MENTION_REGEX = /^<@([A-Z0-9]{9,})(?:\|[^>]+)?>$/i;

function normalizeSlackChannelTarget(
  channel: string,
): { value: string } | { error: string } | null {
  const trimmedChannel = channel.trim();
  if (!trimmedChannel) {
    return null;
  }

  const mentionMatch = trimmedChannel.match(SLACK_CHANNEL_MENTION_REGEX);
  const userMentionMatch = trimmedChannel.match(SLACK_USER_MENTION_REGEX);
  const channelId = (
    mentionMatch?.[1] ??
    userMentionMatch?.[1] ??
    trimmedChannel
  ).toUpperCase();

  if (
    SLACK_CHANNEL_ID_REGEX.test(channelId) ||
    SLACK_DIRECT_MESSAGE_ID_REGEX.test(channelId) ||
    SLACK_USER_ID_REGEX.test(channelId)
  ) {
    return { value: channelId };
  }

  const channelName = trimmedChannel.startsWith('#')
    ? trimmedChannel.slice(1)
    : trimmedChannel;

  if (!/^[^\s#<>|]+$/i.test(channelName)) {
    return { error: CHANNEL_TARGET_ERROR };
  }

  return { value: `#${channelName.toLowerCase()}` };
}

type ChannelPostInput = {
  taskId: string;
  channel: string;
  threadTs?: string;
  text?: string;
  imagePaths?: string[];
  imageArtifactIds?: string[];
};

/**
 * Surface-generic channel post. Slack targets get Slack channel-name
 * normalization; every other provider receives its opaque channel ID
 * unchanged for provider-specific authorization and delivery.
 */
export async function handlePostToChannel(
  input: ChannelPostInput,
  artifactConfig: ArtifactConfig,
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  const provider =
    process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim().toLowerCase();
  const rawChannel = input.channel.trim();
  if (!rawChannel) {
    return errorResult('channel is required');
  }

  let channel = rawChannel;
  if (!provider || provider === 'slack') {
    const channelTarget = normalizeSlackChannelTarget(rawChannel);
    if (!channelTarget) {
      return errorResult('channel is required');
    }
    if ('error' in channelTarget) {
      return errorResult(channelTarget.error);
    }
    channel = channelTarget.value;
  }

  return postChannelMessage(
    { ...input, channel },
    artifactConfig,
    roomoteConfig,
  );
}

async function postChannelMessage(
  input: ChannelPostInput,
  artifactConfig: ArtifactConfig,
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  const threadTs = normalizeOptionalText(input.threadTs);
  const text = normalizeOptionalSlackText(input.text);
  const imagePaths = uniqueNonEmpty(input.imagePaths);
  const imageArtifactIds = uniqueNonEmpty(input.imageArtifactIds);

  const contentValidation = validateSlackPostContent({
    text,
    imagePaths,
    imageArtifactIds,
  });
  if (contentValidation) {
    return contentValidation;
  }

  if (imagePaths.length > 0 && !artifactConfig.workspacePath) {
    return errorResult('ROOMOTE_WORKSPACE_PATH not set');
  }

  const uploadedArtifactIds: string[] = [];
  const allArtifactIds = [...imageArtifactIds];

  try {
    const uploads = await uploadSlackImagePaths({
      taskId: input.taskId,
      imagePaths,
      artifactConfig,
    });
    uploadedArtifactIds.push(...uploads.uploadedArtifactIds);
    allArtifactIds.push(...uploads.uploadedArtifactIds);

    const reply = await postToChannel(roomoteConfig, {
      channel: input.channel,
      ...(threadTs && { threadTs }),
      ...(text && { text }),
      ...(allArtifactIds.length > 0 && {
        images: allArtifactIds.map((artifactId) => ({ artifactId })),
      }),
    });

    return successResult({
      messageTs: reply.messageTs,
      channelId: reply.channelId,
      ...(uploadedArtifactIds.length > 0 && { uploadedArtifactIds }),
      ...(imageArtifactIds.length > 0 && { imageArtifactIds }),
    });
  } catch (error) {
    if (uploadedArtifactIds.length > 0) {
      return errorResultWithArtifacts(
        error instanceof Error ? error.message : String(error),
        uploadedArtifactIds,
      );
    }

    return catchError(error);
  }
}
