import { Buffer } from 'node:buffer';

import {
  isRoomoteImageAttachment,
  isRoomoteTextExtractableAttachment,
} from '@roomote/cloud-agents';
import {
  appendAttachmentTextsToPromptText,
  extractPromptTextAttachments,
} from '@roomote/cloud-agents/server';
import type { RoomoteMessageAttachment } from '@roomote/types';

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export async function prepareMessageAttachments(input: {
  message: string;
  attachments?: RoomoteMessageAttachment[];
}): Promise<{
  message: string;
  images?: string[];
  attachmentTexts?: string[];
}> {
  if (!input.attachments?.length) {
    return { message: input.message };
  }

  const images: string[] = [];
  const textAttachments: Array<{
    filename: string;
    mimeType: string;
    bytes: Buffer;
  }> = [];

  for (const attachment of input.attachments) {
    if (!BASE64_PATTERN.test(attachment.base64)) {
      throw new Error(`${attachment.filename}: base64 is invalid`);
    }

    const bytes = Buffer.from(attachment.base64, 'base64');
    if (
      isRoomoteImageAttachment({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
      })
    ) {
      images.push(`data:${attachment.mimeType};base64,${attachment.base64}`);
      continue;
    }

    if (
      !isRoomoteTextExtractableAttachment({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
      })
    ) {
      throw new Error(`${attachment.filename}: unsupported attachment type`);
    }

    textAttachments.push({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      bytes,
    });
  }

  const extracted = await extractPromptTextAttachments(textAttachments);
  if (extracted.warnings.length > 0) {
    throw new Error(extracted.warnings.join('; '));
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
