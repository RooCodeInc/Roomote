import { appendAttachmentTextsToPromptText } from '@roomote/cloud-agents';
import { formatErrorForLog } from '@roomote/types';
import { isRoomoteTextExtractableAttachment } from '@roomote/cloud-agents';
import {
  describeVideoAttachment,
  extractPromptTextAttachments,
  isVideoAgentSupportedMimeType,
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
} from '@roomote/cloud-agents/server';
import {
  appendSlackVideoDescriptionsToText,
  collectAndExtractThreadAttachmentTexts,
  type SlackFile,
  type SlackNotifier,
  type SlackThreadMessage,
} from '@roomote/slack';

function getFirstSlackVideoFile(files: SlackFile[]): SlackFile | undefined {
  return files.find(
    (file) =>
      file.mimetype.startsWith('video/') &&
      isVideoAgentSupportedMimeType(file.mimetype) &&
      file.size <= VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
  );
}

export async function processSlackAttachments({
  slack,
  files,
  userTextContext,
  userId,
}: {
  slack: SlackNotifier;
  files?: SlackFile[];
  userTextContext?: string;
  userId?: string;
}): Promise<{
  images: string[];
  attachmentTexts: string[];
  videoDescriptions: string[];
}> {
  if (!files?.length) {
    return { images: [], attachmentTexts: [], videoDescriptions: [] };
  }

  const firstVideoFile = getFirstSlackVideoFile(files);

  const imagePromise = slack.processSlackFiles(files).catch((error) => {
    console.error(
      `[SlackWebhook] Failed to process Slack image files: ${formatErrorForLog(error)}`,
    );
    return [] as string[];
  });

  const videoDescriptionPromise = (async () => {
    if (!firstVideoFile) {
      return [] as string[];
    }

    const fileBytes = await slack.downloadSlackFile(firstVideoFile);
    if (!fileBytes) {
      return [] as string[];
    }

    const description = await describeVideoAttachment({
      userId,
      videoBytes: fileBytes,
      mimeType: firstVideoFile.mimetype,
      userTextContext,
    });

    return description ? [description] : [];
  })().catch((error) => {
    console.error(
      `[SlackWebhook] Failed to process Slack video file: ${formatErrorForLog(error)}`,
    );
    return [] as string[];
  });

  const attachmentTextPromise = (async () => {
    const textExtractableFiles = files.filter((file) =>
      isRoomoteTextExtractableAttachment({
        filename: file.name,
        mimeType: file.mimetype,
      }),
    );

    if (textExtractableFiles.length === 0) {
      return [] as string[];
    }

    const extractedInputs = await Promise.all(
      textExtractableFiles.map(async (file) => {
        const fileBytes = await slack.downloadSlackFile(file);
        if (!fileBytes) {
          return null;
        }

        return {
          filename: file.name,
          mimeType: file.mimetype,
          bytes: fileBytes,
        };
      }),
    );

    const { attachmentTexts, warnings } = await extractPromptTextAttachments(
      extractedInputs.filter((input) => input !== null),
    );

    for (const warning of warnings) {
      console.warn(`[SlackWebhook] Attachment extraction warning: ${warning}`);
    }

    return attachmentTexts;
  })().catch((error) => {
    console.error(
      `[SlackWebhook] Failed to process Slack file attachments: ${formatErrorForLog(error)}`,
    );
    return [] as string[];
  });

  const [images, attachmentTexts, videoDescriptions] = await Promise.all([
    imagePromise,
    attachmentTextPromise,
    videoDescriptionPromise,
  ]);

  return { images, attachmentTexts, videoDescriptions };
}

export async function buildResolvedCurrentMessageText({
  slack,
  claimedMessages,
  excludeFileIds,
  logContext,
  userId,
  messageText,
  currentAttachmentTexts,
  currentVideoDescriptions,
}: {
  slack: SlackNotifier;
  claimedMessages: SlackThreadMessage[];
  excludeFileIds?: Set<string>;
  logContext: string;
  userId?: string;
  messageText: string;
  currentAttachmentTexts: string[];
  currentVideoDescriptions: string[];
}): Promise<string> {
  const claimedAttachmentTexts = await collectAndExtractThreadAttachmentTexts({
    extractSlackAttachmentTexts: async (files) =>
      (
        await processSlackAttachments({
          slack,
          files,
          userId,
          userTextContext: messageText,
        })
      ).attachmentTexts,
    messages: claimedMessages,
    excludeFileIds,
    logContext,
  });

  return appendSlackVideoDescriptionsToText({
    text: appendAttachmentTextsToPromptText({
      text: messageText,
      attachmentTexts: [...currentAttachmentTexts, ...claimedAttachmentTexts],
    }),
    videoDescriptions: currentVideoDescriptions,
  });
}
