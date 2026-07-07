import {
  isRoomoteImageAttachment,
  isRoomoteTextExtractableAttachment,
} from '@roomote/cloud-agents';
import { formatErrorForLog } from '@roomote/types';

import type { SlackFile, SlackThreadMessage } from './types';

const MAX_SLACK_IMAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const MAX_THREAD_IMAGE_FILES = 20;
export const MAX_THREAD_ATTACHMENT_FILES = 20;

export function isSlackImageFile(file: SlackFile): boolean {
  return (
    isRoomoteImageAttachment({
      filename: file.name,
      mimeType: file.mimetype,
    }) && file.size < MAX_SLACK_IMAGE_FILE_SIZE_BYTES
  );
}

export function collectThreadImageFiles(
  messages: SlackThreadMessage[],
  options?: {
    excludeFileIds?: Set<string>;
    maxFiles?: number;
  },
): {
  files: SlackFile[];
  skippedCount: number;
} {
  const seenFileIds = new Set<string>(options?.excludeFileIds);
  const imageFiles: SlackFile[] = [];

  for (const message of messages) {
    for (const file of message.files ?? []) {
      if (!isSlackImageFile(file) || seenFileIds.has(file.id)) {
        continue;
      }

      seenFileIds.add(file.id);
      imageFiles.push(file);
    }
  }

  const maxFiles = options?.maxFiles ?? Number.POSITIVE_INFINITY;

  if (imageFiles.length <= maxFiles) {
    return { files: imageFiles, skippedCount: 0 };
  }

  return {
    files: imageFiles.slice(-maxFiles),
    skippedCount: imageFiles.length - maxFiles,
  };
}

export function collectThreadTextAttachmentFiles(
  messages: SlackThreadMessage[],
  options?: {
    excludeFileIds?: Set<string>;
    maxFiles?: number;
  },
): {
  files: SlackFile[];
  skippedCount: number;
} {
  const seenFileIds = new Set<string>(options?.excludeFileIds);
  const attachmentFiles: SlackFile[] = [];

  for (const message of messages) {
    for (const file of message.files ?? []) {
      if (
        seenFileIds.has(file.id) ||
        isSlackImageFile(file) ||
        !isRoomoteTextExtractableAttachment({
          filename: file.name,
          mimeType: file.mimetype,
        })
      ) {
        continue;
      }

      seenFileIds.add(file.id);
      attachmentFiles.push(file);
    }
  }

  const maxFiles = options?.maxFiles ?? Number.POSITIVE_INFINITY;

  if (attachmentFiles.length <= maxFiles) {
    return { files: attachmentFiles, skippedCount: 0 };
  }

  return {
    files: attachmentFiles.slice(-maxFiles),
    skippedCount: attachmentFiles.length - maxFiles,
  };
}

export async function collectAndProcessThreadImages({
  processSlackFiles,
  messages,
  excludeFileIds,
  logContext,
}: {
  processSlackFiles: (files: SlackFile[]) => Promise<string[]>;
  messages: SlackThreadMessage[];
  excludeFileIds?: Set<string>;
  logContext: string;
}): Promise<string[]> {
  const { files, skippedCount } = collectThreadImageFiles(messages, {
    excludeFileIds,
    maxFiles: MAX_THREAD_IMAGE_FILES,
  });

  if (skippedCount > 0) {
    console.warn(
      `[thread-image-utils] Skipping ${skippedCount} older thread image(s) for ${logContext} after keeping the ${MAX_THREAD_IMAGE_FILES} most recent image(s)`,
    );
  }

  if (files.length === 0) {
    return [];
  }

  return processSlackFiles(files).catch((error) => {
    console.error(
      `[thread-image-utils] Failed to process thread image files for ${logContext}: ${formatErrorForLog(error)}`,
    );
    return [] as string[];
  });
}

export async function collectAndExtractThreadAttachmentTexts({
  extractSlackAttachmentTexts,
  messages,
  excludeFileIds,
  logContext,
}: {
  extractSlackAttachmentTexts: (files: SlackFile[]) => Promise<string[]>;
  messages: SlackThreadMessage[];
  excludeFileIds?: Set<string>;
  logContext: string;
}): Promise<string[]> {
  const { files, skippedCount } = collectThreadTextAttachmentFiles(messages, {
    excludeFileIds,
    maxFiles: MAX_THREAD_ATTACHMENT_FILES,
  });

  if (skippedCount > 0) {
    console.warn(
      `[thread-image-utils] Skipping ${skippedCount} older thread attachment(s) for ${logContext} after keeping the ${MAX_THREAD_ATTACHMENT_FILES} most recent attachment(s)`,
    );
  }

  if (files.length === 0) {
    return [];
  }

  return extractSlackAttachmentTexts(files).catch((error) => {
    console.error(
      `[thread-image-utils] Failed to process thread file attachments for ${logContext}: ${formatErrorForLog(error)}`,
    );
    return [] as string[];
  });
}

export function resolveCurrentSlackMessageFiles(params: {
  currentMessageTs: string;
  eventFiles?: SlackFile[];
  messages: SlackThreadMessage[];
}): SlackFile[] | undefined {
  if (params.eventFiles && params.eventFiles.length > 0) {
    return params.eventFiles;
  }

  const currentMessage = params.messages.find(
    (message) => message.ts === params.currentMessageTs,
  );

  return currentMessage?.files?.length ? currentMessage.files : undefined;
}

export async function fetchThreadMessagesSafe({
  fetchThreadMessages,
  channel,
  threadTs,
  logContext,
}: {
  fetchThreadMessages: (params: {
    channel: string;
    threadTs: string;
  }) => Promise<SlackThreadMessage[]>;
  channel: string;
  threadTs: string;
  logContext: string;
}): Promise<SlackThreadMessage[]> {
  return fetchThreadMessages({ channel, threadTs }).catch((error) => {
    console.warn(
      `[thread-image-utils] Failed to fetch thread messages for ${logContext}: ${formatErrorForLog(error)}`,
    );
    return [] as SlackThreadMessage[];
  });
}
