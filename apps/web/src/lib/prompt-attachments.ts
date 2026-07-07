'use client';

import {
  ROOMOTE_FILE_ATTACHMENT_ACCEPT,
  appendAttachmentTextsToPromptText,
  isRoomoteImageAttachment,
} from '@roomote/cloud-agents';

import { processImageFiles } from './image-utils';

type PromptAttachmentPart = {
  url?: string;
  filename?: string;
  mediaType?: string;
};

async function resolveAttachmentFiles(
  attachments: PromptAttachmentPart[] | undefined,
): Promise<File[]> {
  if (!attachments?.length) {
    return [];
  }

  return Promise.all(
    attachments
      .filter((attachment) => attachment.url)
      .map(async (attachment) => {
        const response = await fetch(attachment.url!);
        const blob = await response.blob();

        return new File([blob], attachment.filename || 'attachment', {
          type: attachment.mediaType || blob.type,
        });
      }),
  );
}

async function extractAttachmentTexts(files: File[]): Promise<string[]> {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  const response = await fetch('/api/file-attachments/extract', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error || 'Failed to process file attachments.');
  }

  const body = (await response.json()) as {
    attachmentTexts?: string[];
    warnings?: string[];
  };

  if (Array.isArray(body.warnings)) {
    for (const warning of body.warnings) {
      console.warn(`[prompt-attachments] ${warning}`);
    }
  }

  return Array.isArray(body.attachmentTexts) ? body.attachmentTexts : [];
}

export async function preparePromptAttachments(input: {
  text: string;
  attachments?: PromptAttachmentPart[];
}): Promise<{ text: string; images?: string[] }> {
  const files = await resolveAttachmentFiles(input.attachments);
  const imageFiles = files.filter((file) =>
    isRoomoteImageAttachment({
      filename: file.name,
      mimeType: file.type,
    }),
  );
  const nonImageFiles = files.filter((file) => !imageFiles.includes(file));

  const [processedImages, attachmentTexts] = await Promise.all([
    imageFiles.length > 0 ? processImageFiles(imageFiles) : Promise.resolve([]),
    extractAttachmentTexts(nonImageFiles),
  ]);

  return {
    text: appendAttachmentTextsToPromptText({
      text: input.text,
      attachmentTexts,
    }),
    ...(processedImages.length > 0
      ? { images: processedImages.map((image) => image.dataUrl) }
      : {}),
  };
}

export { ROOMOTE_FILE_ATTACHMENT_ACCEPT };
