import { isRoomoteTextExtractableAttachment } from '@roomote/cloud-agents';
import {
  AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES,
  extractPromptTextAttachments,
  formatAudioAttachmentWarning,
  formatAudioTranscriptionResult,
  resolveAudioTranscriptionMimeType,
  transcribeAudioAttachment,
} from '@roomote/cloud-agents/server';
import type { DiscordAttachment } from '@roomote/communication/discord-event';
import {
  isDiscordImageAttachment,
  isDiscordAudioAttachment,
  isDiscordTextDocumentAttachment,
} from '@roomote/communication/discord-event';
import { formatErrorForLog } from '@roomote/types';

const DISCORD_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);
const MAX_DISCORD_ATTACHMENTS = 6;
const MAX_DISCORD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DISCORD_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_DISCORD_TOTAL_BYTES = 30 * 1024 * 1024;
const DISCORD_ATTACHMENT_TIMEOUT_MS = 10_000;

type DownloadedAttachment = {
  bytes: Uint8Array;
  contentType?: string;
};

function validatedDiscordAttachmentUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !DISCORD_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error('Discord attachment URL is outside the trusted CDN.');
  }
  return url;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Discord attachment exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Discord attachment exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function downloadAttachment(input: {
  attachment: DiscordAttachment;
  maxBytes: number;
  fetchImpl: typeof fetch;
}): Promise<DownloadedAttachment> {
  if (input.attachment.size > input.maxBytes) {
    throw new Error(`Discord attachment exceeds ${input.maxBytes} bytes.`);
  }
  const url = validatedDiscordAttachmentUrl(input.attachment.url);
  const response = await input.fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DISCORD_ATTACHMENT_TIMEOUT_MS),
    headers: { 'user-agent': 'Roomote Discord Attachment Fetcher' },
  });
  if (!response.ok) {
    throw new Error(
      `Discord attachment download failed with HTTP ${response.status}.`,
    );
  }
  return {
    bytes: await readBoundedBody(response, input.maxBytes),
    ...(response.headers.get('content-type')
      ? { contentType: response.headers.get('content-type')! }
      : {}),
  };
}

type ProcessedDiscordAttachments = {
  images: string[];
  attachmentTexts: string[];
  warnings: string[];
};

/**
 * Discord CDN URLs are signed and expire. Materialize safe inputs immediately;
 * no URL or bot credential is ever placed in a queued task prompt.
 */
export async function processDiscordAttachments(
  attachments: DiscordAttachment[],
  options: {
    fetch?: typeof fetch;
    userId?: string;
    userTextContext?: string;
  } = {},
): Promise<ProcessedDiscordAttachments> {
  const fetchImpl = options.fetch ?? fetch;
  const images: string[] = [];
  const attachmentTexts: string[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  let audioProcessed = false;

  for (const attachment of attachments.slice(0, MAX_DISCORD_ATTACHMENTS)) {
    const isImage = isDiscordImageAttachment(attachment);
    const isAudio = isDiscordAudioAttachment(attachment);
    const isText =
      isDiscordTextDocumentAttachment(attachment) &&
      isRoomoteTextExtractableAttachment({
        filename: attachment.filename,
        mimeType: attachment.content_type,
      });
    if (!isImage && !isText && !isAudio) continue;

    if (isAudio && audioProcessed) {
      warnings.push('Only the first audio attachment was transcribed.');
      continue;
    }
    if (isAudio) audioProcessed = true;

    const audioMimeType = isAudio
      ? resolveAudioTranscriptionMimeType({
          mimeType: attachment.content_type,
          filename: attachment.filename,
        })
      : null;
    if (isAudio && !audioMimeType) {
      attachmentTexts.push(
        formatAudioAttachmentWarning(
          attachment.filename,
          `could not be transcribed because ${attachment.content_type ?? 'its media type'} is not supported`,
        ),
      );
      continue;
    }

    const maxBytes = isImage
      ? MAX_DISCORD_IMAGE_BYTES
      : isAudio
        ? AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES
        : MAX_DISCORD_DOCUMENT_BYTES;
    if (isAudio && attachment.size > AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES) {
      attachmentTexts.push(
        formatAudioAttachmentWarning(
          attachment.filename,
          'could not be transcribed because it exceeds the 20 MiB limit',
        ),
      );
      continue;
    }
    if (totalBytes + attachment.size > MAX_DISCORD_TOTAL_BYTES) {
      warnings.push(
        `Skipped ${attachment.filename}: attachment total is too large.`,
      );
      continue;
    }
    try {
      const downloaded = await downloadAttachment({
        attachment,
        maxBytes,
        fetchImpl,
      });
      totalBytes += downloaded.bytes.byteLength;
      if (isImage) {
        const reportedMime =
          downloaded.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
        const attachmentMime = attachment.content_type?.toLowerCase() ?? '';
        const mimeType = reportedMime.startsWith('image/')
          ? reportedMime
          : attachmentMime.startsWith('image/')
            ? attachmentMime
            : 'image/png';
        images.push(
          `data:${mimeType};base64,${Buffer.from(downloaded.bytes).toString('base64')}`,
        );
        continue;
      }
      if (isAudio && audioMimeType) {
        const result = await transcribeAudioAttachment({
          audioBytes: Buffer.from(downloaded.bytes),
          mimeType: audioMimeType,
          filename: attachment.filename,
          userId: options.userId,
          userTextContext: options.userTextContext,
        });
        attachmentTexts.push(
          formatAudioTranscriptionResult(attachment.filename, result),
        );
        continue;
      }
      const extracted = await extractPromptTextAttachments([
        {
          filename: attachment.filename,
          mimeType:
            attachment.content_type ?? downloaded.contentType ?? undefined,
          bytes: downloaded.bytes,
        },
      ]);
      attachmentTexts.push(...extracted.attachmentTexts);
      warnings.push(...extracted.warnings);
    } catch (error) {
      if (isAudio) {
        attachmentTexts.push(
          formatAudioAttachmentWarning(
            attachment.filename,
            'could not be downloaded',
          ),
        );
      } else {
        warnings.push(
          `Skipped ${attachment.filename}: ${formatErrorForLog(error)}`,
        );
      }
    }
  }

  if (attachments.length > MAX_DISCORD_ATTACHMENTS) {
    warnings.push(
      `Skipped ${attachments.length - MAX_DISCORD_ATTACHMENTS} extra attachment(s).`,
    );
  }
  return { images, attachmentTexts, warnings };
}
