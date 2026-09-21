'use client';

import {
  ROOMOTE_FILE_ATTACHMENT_ACCEPT,
  ROOMOTE_ATTACHMENT_TEXT_MAX_CHARS,
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
        if (!response.ok) {
          throw new Error(
            `Failed to download "${attachment.filename || 'attachment'}" (HTTP ${response.status}).`,
          );
        }
        const blob = await response.blob();

        return new File([blob], attachment.filename || 'attachment', {
          type: attachment.mediaType || blob.type,
        });
      }),
  );
}

const ATTACHMENT_TEXT_HEADER_PATTERN = /^File attachment: (.+)$/;

function getAttachmentTextFilename(text: string): string {
  const headerLine = text.split('\n', 1)[0] ?? '';
  const match = ATTACHMENT_TEXT_HEADER_PATTERN.exec(headerLine);
  return match?.[1]?.trim() || 'attachment';
}

function formatCharCount(value: number): string {
  return value.toLocaleString('en-US');
}

function assertAttachmentTextsWithinLimit(texts: string[]): void {
  let totalChars = 0;
  for (const text of texts) {
    totalChars += text.length;
    if (totalChars > ROOMOTE_ATTACHMENT_TEXT_MAX_CHARS) {
      throw new Error(
        `Extracted text from "${getAttachmentTextFilename(text)}" would exceed the ${formatCharCount(ROOMOTE_ATTACHMENT_TEXT_MAX_CHARS)} character limit for attachments (total ${formatCharCount(totalChars)} characters). Remove or shorten the attachment and try again.`,
      );
    }
  }
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

  if (!Array.isArray(body.attachmentTexts)) {
    return [];
  }

  return body.attachmentTexts.filter(
    (text) => typeof text === 'string' && text.length > 0,
  );
}

export async function preparePromptAttachments(
  input: {
    text: string;
    attachments?: PromptAttachmentPart[];
  },
  options?: {
    /**
     * Enforce the Fast Session aggregate attachment-text limit client-side.
     * The standard task and wake composers accept unbounded prompts, so the
     * check stays opt-in to avoid narrowing those flows.
     */
    enforceAttachmentTextLimit?: boolean;
  },
): Promise<{
  text: string;
  images?: string[];
  attachmentTexts?: string[];
}> {
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

  if (options?.enforceAttachmentTextLimit) {
    assertAttachmentTextsWithinLimit(attachmentTexts);
  }

  return {
    text: appendAttachmentTextsToPromptText({
      text: input.text,
      attachmentTexts,
    }),
    ...(processedImages.length > 0
      ? { images: processedImages.map((image) => image.dataUrl) }
      : {}),
    ...(attachmentTexts.length > 0 ? { attachmentTexts } : {}),
  };
}

export { ROOMOTE_FILE_ATTACHMENT_ACCEPT };
