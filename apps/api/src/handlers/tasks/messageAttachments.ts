import { Buffer } from 'node:buffer';

import {
  isRoomotePromptImageMimeType,
  isRoomoteTextExtractableAttachment,
  ROOMOTE_FILE_ATTACHMENT_MAX_BYTES,
  ROOMOTE_IMAGE_ATTACHMENT_MAX_BYTES,
  ROOMOTE_MESSAGE_ATTACHMENTS_MAX_BYTES,
} from '@roomote/cloud-agents';
import {
  appendAttachmentTextsToPromptText,
  extractPromptTextAttachments,
} from '@roomote/cloud-agents/server';
import { roomoteMessageAttachmentsSchema } from '@roomote/types';

export const ROOMOTE_MESSAGE_REQUEST_MAX_BYTES = 24 * 1024 * 1024;

function getBase64Value(charCode: number): number {
  if (charCode >= 65 && charCode <= 90) return charCode - 65;
  if (charCode >= 97 && charCode <= 122) return charCode - 71;
  if (charCode >= 48 && charCode <= 57) return charCode + 4;
  if (charCode === 43) return 62;
  if (charCode === 47) return 63;
  return -1;
}

function getDecodedBase64ByteLength(base64: string): number | null {
  if (base64.length === 0 || base64.length % 4 !== 0) return null;

  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;

  const contentLength = base64.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    if (getBase64Value(base64.charCodeAt(index)) === -1) return null;
  }
  for (let index = contentLength; index < base64.length; index += 1) {
    if (base64.charCodeAt(index) !== 61) return null;
  }

  const finalValue = getBase64Value(base64.charCodeAt(contentLength - 1));
  if (
    (padding === 2 && (finalValue & 15) !== 0) ||
    (padding === 1 && (finalValue & 3) !== 0)
  ) {
    return null;
  }

  return (base64.length / 4) * 3 - padding;
}

function formatMebibytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

function isAttachmentBudgetWarning(warning: string): boolean {
  return warning.endsWith(
    'omitted because the shared attachment text budget was exhausted.',
  );
}

export async function prepareMessageAttachments(input: {
  message: string;
  attachments?: unknown;
}): Promise<{
  message: string;
  images?: string[];
  attachmentTexts?: string[];
}> {
  if (input.attachments === undefined) {
    return { message: input.message };
  }

  const parsed = roomoteMessageAttachmentsSchema.safeParse(input.attachments);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Invalid attachments');
  }
  if (parsed.data.length === 0) return { message: input.message };

  const images: string[] = [];
  const textAttachments: Array<{
    filename: string;
    mimeType: string;
    bytes: Buffer;
  }> = [];
  let totalDecodedBytes = 0;

  for (const attachment of parsed.data) {
    const mimeType = attachment.mimeType.trim().toLowerCase();
    const isImage = isRoomotePromptImageMimeType(mimeType);
    const isTextExtractable = isRoomoteTextExtractableAttachment({
      filename: attachment.filename,
      mimeType,
    });
    if (!isImage && !isTextExtractable) {
      throw new Error(`${attachment.filename}: unsupported attachment type`);
    }

    const decodedByteLength = getDecodedBase64ByteLength(attachment.base64);
    if (decodedByteLength === null) {
      throw new Error(`${attachment.filename}: base64 is invalid`);
    }

    const maxBytes = isImage
      ? ROOMOTE_IMAGE_ATTACHMENT_MAX_BYTES
      : ROOMOTE_FILE_ATTACHMENT_MAX_BYTES;
    if (decodedByteLength > maxBytes) {
      throw new Error(
        `${attachment.filename}: file exceeds the ${formatMebibytes(maxBytes)} attachment limit`,
      );
    }
    totalDecodedBytes += decodedByteLength;
    if (totalDecodedBytes > ROOMOTE_MESSAGE_ATTACHMENTS_MAX_BYTES) {
      throw new Error(
        `attachments exceed the ${formatMebibytes(ROOMOTE_MESSAGE_ATTACHMENTS_MAX_BYTES)} total limit`,
      );
    }

    if (isImage) {
      images.push(`data:${mimeType};base64,${attachment.base64}`);
      continue;
    }

    textAttachments.push({
      filename: attachment.filename,
      mimeType,
      bytes: Buffer.from(attachment.base64, 'base64'),
    });
  }

  const extracted = await extractPromptTextAttachments(textAttachments);
  const extractionErrors = extracted.warnings.filter(
    (warning) => !isAttachmentBudgetWarning(warning),
  );
  if (extractionErrors.length > 0) {
    throw new Error(extractionErrors.join('; '));
  }
  for (const warning of extracted.warnings) {
    console.warn(`[message-attachments] ${warning}`);
  }

  return {
    message: appendAttachmentTextsToPromptText({
      text: input.message,
      attachmentTexts: extracted.attachmentTexts,
    }),
    ...(images.length ? { images } : {}),
    ...(extracted.attachmentTexts.length
      ? { attachmentTexts: extracted.attachmentTexts }
      : {}),
  };
}
