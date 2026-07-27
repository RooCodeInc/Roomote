import { postToSlackChannel } from './slack-api-client.js';
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
  'channel must be a Slack channel ID, channel name, or Slack channel mention like C123ABC456, #eng, eng, or <#C123ABC456>';
const DIRECT_MESSAGE_ERROR =
  'direct message IDs are not supported; use a Slack channel ID or channel name instead';
const SLACK_CHANNEL_ID_REGEX = /^[CG][A-Z0-9]{8,}$/i;
const SLACK_DIRECT_MESSAGE_ID_REGEX = /^D[A-Z0-9]{8,}$/i;
const SLACK_CHANNEL_MENTION_REGEX = /^<#([A-Z0-9]{9,})(?:\|[^>]+)?>$/i;

function normalizeSlackChannelTarget(
  channel: string,
): { value: string } | { error: string } | null {
  const trimmedChannel = channel.trim();
  if (!trimmedChannel) {
    return null;
  }

  const mentionMatch = trimmedChannel.match(SLACK_CHANNEL_MENTION_REGEX);
  const channelId = (mentionMatch?.[1] ?? trimmedChannel).toUpperCase();

  if (SLACK_DIRECT_MESSAGE_ID_REGEX.test(channelId)) {
    return { error: DIRECT_MESSAGE_ERROR };
  }

  if (SLACK_CHANNEL_ID_REGEX.test(channelId)) {
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

export async function handlePostToSlackChannel(
  input: ChannelPostInput,
  artifactConfig: ArtifactConfig,
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  const rawChannel = input.channel.trim();
  if (!rawChannel) {
    return errorResult('channel is required');
  }
  const channelTarget = normalizeSlackChannelTarget(rawChannel);
  if (!channelTarget) {
    return errorResult('channel is required');
  }
  if ('error' in channelTarget) {
    return errorResult(channelTarget.error);
  }

  return postChannelMessage(
    { ...input, channel: channelTarget.value },
    artifactConfig,
    roomoteConfig,
  );
}

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

  if (!provider || provider === 'slack') {
    return handlePostToSlackChannel(input, artifactConfig, roomoteConfig);
  }

  const channel = input.channel.trim();
  if (!channel) {
    return errorResult('channel is required');
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

    const reply = await postToSlackChannel(roomoteConfig, {
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
