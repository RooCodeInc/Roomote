import {
  appendAttachmentTextsToPromptText,
  isRoomoteImageAttachment,
  isRoomoteTextExtractableAttachment,
} from '@roomote/cloud-agents';
import {
  AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES,
  describeVideoAttachment,
  extractPromptTextAttachments,
  formatAudioAttachmentWarning,
  formatAudioTranscriptionResult,
  isVideoAgentSupportedMimeType,
  resolveAudioTranscriptionMimeType,
  transcribeAudioAttachment,
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
} from '@roomote/cloud-agents/server';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import type { TelegramMessage } from '@roomote/communication/telegram-update';
import { formatErrorForLog } from '@roomote/types';

import type { QueuedTelegramCommunicationMessage } from './types.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export async function attachTelegramMediaToQueuedMessage(input: {
  message: TelegramMessage;
  queuedMessage: QueuedTelegramCommunicationMessage;
  botToken?: string;
}): Promise<QueuedTelegramCommunicationMessage> {
  const audio = input.message.voice ?? input.message.audio;
  const video = input.message.video ?? input.message.video_note;
  if (!input.botToken) {
    if (!audio && !video) return input.queuedMessage;
    const warnings = [];
    if (audio) {
      const filename = input.message.voice
        ? 'voice-message.ogg'
        : (input.message.audio?.file_name ?? 'audio-attachment');
      warnings.push(
        formatAudioAttachmentWarning(filename, 'could not be downloaded'),
      );
    }
    if (video) {
      const filename = input.message.video_note
        ? 'video-note.mp4'
        : (input.message.video?.file_name ?? 'video-attachment');
      warnings.push(`Video attachment ${filename} could not be downloaded.`);
    }
    return {
      ...input.queuedMessage,
      text: appendAttachmentTextsToPromptText({
        text: input.queuedMessage.text,
        attachmentTexts: warnings,
      }),
    };
  }
  const provider = new TelegramCommunicationProvider({
    botToken: input.botToken,
  });
  const images: string[] = [];
  const attachmentTexts: string[] = [];

  try {
    const photo = input.message.photo?.at(-1);
    if (photo) {
      const downloaded = await provider.downloadFile(
        photo.file_id,
        MAX_IMAGE_BYTES,
      );
      const downloadedMimeType = downloaded.contentType?.split(';')[0];
      const mimeType = downloadedMimeType?.startsWith('image/')
        ? downloadedMimeType
        : 'image/jpeg';
      images.push(
        `data:${mimeType};base64,${Buffer.from(downloaded.bytes).toString('base64')}`,
      );
    }

    const document = input.message.document;
    const documentMimeType = document?.mime_type?.trim().toLowerCase();
    const documentIsImage = Boolean(
      document &&
      isRoomoteImageAttachment({
        filename: document.file_name,
        mimeType: document.mime_type,
      }),
    );
    const documentIsText = Boolean(
      document &&
      isRoomoteTextExtractableAttachment({
        filename: document.file_name,
        mimeType: document.mime_type,
      }),
    );
    const documentIsVideo = Boolean(
      documentMimeType && isVideoAgentSupportedMimeType(documentMimeType),
    );
    if (document && (documentIsImage || documentIsText || documentIsVideo)) {
      const downloaded = await provider.downloadFile(
        document.file_id,
        documentIsImage
          ? MAX_IMAGE_BYTES
          : documentIsVideo
            ? VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES
            : MAX_DOCUMENT_BYTES,
      );
      if (documentIsImage) {
        const downloadedMimeType = downloaded.contentType?.split(';')[0];
        const mimeType = downloadedMimeType?.startsWith('image/')
          ? downloadedMimeType
          : documentMimeType?.startsWith('image/')
            ? documentMimeType
            : 'image/png';
        images.push(
          `data:${mimeType};base64,${Buffer.from(downloaded.bytes).toString('base64')}`,
        );
      } else if (documentIsVideo && documentMimeType) {
        const description = await describeVideoAttachment({
          videoBytes: Buffer.from(downloaded.bytes),
          mimeType: documentMimeType,
          userId: input.queuedMessage.userId,
          userTextContext: input.queuedMessage.text,
        });
        if (description) {
          attachmentTexts.push(
            `Video attachment description${document.file_name ? `: ${document.file_name}` : ''}\n${description}`,
          );
        }
      } else {
        const extracted = await extractPromptTextAttachments([
          {
            filename: document.file_name ?? downloaded.filePath,
            mimeType: document.mime_type ?? downloaded.contentType ?? undefined,
            bytes: downloaded.bytes,
          },
        ]);
        attachmentTexts.push(...extracted.attachmentTexts);
        for (const warning of extracted.warnings) {
          console.warn(`[telegram] Attachment extraction warning: ${warning}`);
        }
      }
    }
  } catch (error) {
    console.warn(
      `[telegram] Failed to process inbound attachment: ${formatErrorForLog(error)}`,
    );
  }

  if (video) {
    const filename = input.message.video_note
      ? 'video-note.mp4'
      : (input.message.video?.file_name ?? 'video-attachment');
    const mimeType = input.message.video_note
      ? 'video/mp4'
      : input.message.video?.mime_type?.trim().toLowerCase();
    if (!mimeType || !isVideoAgentSupportedMimeType(mimeType)) {
      attachmentTexts.push(
        `Video attachment ${filename} could not be described because ${mimeType ?? 'its media type'} is not supported.`,
      );
    } else if (
      video.file_size &&
      video.file_size > VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES
    ) {
      attachmentTexts.push(
        `Video attachment ${filename} could not be described because it exceeds the supported size limit.`,
      );
    } else {
      try {
        const downloaded = await provider.downloadFile(
          video.file_id,
          VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
        );
        const description = await describeVideoAttachment({
          videoBytes: Buffer.from(downloaded.bytes),
          mimeType,
          userId: input.queuedMessage.userId,
          userTextContext: input.queuedMessage.text,
        });
        if (description) {
          attachmentTexts.push(
            `Video attachment description: ${filename}\n${description}`,
          );
        }
      } catch (error) {
        console.warn(
          `[telegram] Failed to process inbound video attachment: ${formatErrorForLog(error)}`,
        );
        attachmentTexts.push(
          `Video attachment ${filename} could not be downloaded.`,
        );
      }
    }
  }

  if (audio) {
    const filename = input.message.voice
      ? 'voice-message.ogg'
      : (input.message.audio?.file_name ?? 'audio-attachment');
    const mimeType = resolveAudioTranscriptionMimeType({
      mimeType: audio.mime_type,
      filename,
    });
    if (!mimeType) {
      attachmentTexts.push(
        formatAudioAttachmentWarning(
          filename,
          `could not be transcribed because ${audio.mime_type ?? 'its media type'} is not supported`,
        ),
      );
    } else if (
      audio.file_size &&
      audio.file_size > AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES
    ) {
      attachmentTexts.push(
        formatAudioAttachmentWarning(
          filename,
          'could not be transcribed because it exceeds the 20 MiB limit',
        ),
      );
    } else {
      try {
        const downloaded = await provider.downloadFile(
          audio.file_id,
          AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES,
        );
        const result = await transcribeAudioAttachment({
          audioBytes: Buffer.from(downloaded.bytes),
          mimeType,
          filename,
          userId: input.queuedMessage.userId,
          userTextContext: input.queuedMessage.text,
        });
        attachmentTexts.push(formatAudioTranscriptionResult(filename, result));
      } catch (error) {
        console.warn(
          `[telegram] Failed to process inbound audio attachment: ${formatErrorForLog(error)}`,
        );
        attachmentTexts.push(
          formatAudioAttachmentWarning(filename, 'could not be downloaded'),
        );
      }
    }
  }

  return {
    ...input.queuedMessage,
    text: appendAttachmentTextsToPromptText({
      text: input.queuedMessage.text,
      attachmentTexts,
    }),
    ...(images.length ? { images } : {}),
    ...(attachmentTexts.length ? { attachmentTexts } : {}),
  };
}
