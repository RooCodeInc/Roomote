import { appendAttachmentTextsToPromptText } from '@roomote/cloud-agents';
import { formatErrorForLog } from '@roomote/types';
import { isRoomoteTextExtractableAttachment } from '@roomote/cloud-agents';
import {
  AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES,
  describeVideoAttachment,
  extractPromptTextAttachments,
  isAudioTranscriptionSupportedMimeType,
  isVideoAgentSupportedMimeType,
  transcribeAudioAttachment,
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

function getSlackAudioFiles(files: SlackFile[]): SlackFile[] {
  return files.filter((file) => file.mimetype.startsWith('audio/'));
}

function formatAudioTranscript(filename: string, transcript: string): string {
  return `Audio attachment transcript ("${filename}"):\n${transcript}`;
}

function formatAudioWarning(filename: string, reason: string): string {
  return `[Audio attachment "${filename}" ${reason}.]`;
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
  const audioFiles = getSlackAudioFiles(files);
  const firstAudioFile = audioFiles[0];

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

  const audioTranscriptPromise = (async () => {
    if (!firstAudioFile) {
      return [] as string[];
    }

    if (!isAudioTranscriptionSupportedMimeType(firstAudioFile.mimetype)) {
      return [
        formatAudioWarning(
          firstAudioFile.name,
          `could not be transcribed because ${firstAudioFile.mimetype} is not supported`,
        ),
      ];
    }

    if (firstAudioFile.size > AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES) {
      return [
        formatAudioWarning(
          firstAudioFile.name,
          'could not be transcribed because it exceeds the 20 MiB limit',
        ),
      ];
    }

    const fileBytes = await slack.downloadSlackFile(firstAudioFile);
    if (!fileBytes) {
      return [
        formatAudioWarning(firstAudioFile.name, 'could not be downloaded'),
      ];
    }

    const result = await transcribeAudioAttachment({
      audioBytes: fileBytes,
      mimeType: firstAudioFile.mimetype,
      filename: firstAudioFile.name,
      userId,
      userTextContext,
    });
    const messages =
      result.status === 'transcribed'
        ? [formatAudioTranscript(firstAudioFile.name, result.transcript)]
        : result.status === 'unsupported_model'
          ? [
              formatAudioWarning(
                firstAudioFile.name,
                'could not be transcribed because no configured model supports audio input',
              ),
            ]
          : result.status === 'oversized'
            ? [
                formatAudioWarning(
                  firstAudioFile.name,
                  'could not be transcribed because it exceeds the 20 MiB limit',
                ),
              ]
            : [
                formatAudioWarning(
                  firstAudioFile.name,
                  'could not be transcribed',
                ),
              ];

    if (audioFiles.length > 1) {
      messages.push(
        `[Only the first of ${audioFiles.length} audio attachments was transcribed.]`,
      );
    }

    return messages;
  })().catch((error) => {
    console.error(
      `[SlackWebhook] Failed to process Slack audio file: ${formatErrorForLog(error)}`,
    );
    return firstAudioFile
      ? [formatAudioWarning(firstAudioFile.name, 'could not be transcribed')]
      : [];
  });

  const [images, attachmentTexts, videoDescriptions, audioTranscriptTexts] =
    await Promise.all([
      imagePromise,
      attachmentTextPromise,
      videoDescriptionPromise,
      audioTranscriptPromise,
    ]);

  return {
    images,
    attachmentTexts: [...attachmentTexts, ...audioTranscriptTexts],
    videoDescriptions,
  };
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
