import type { TaskMessageContentBlock } from '@roomote/types';

import type { NonTaskPromptFile } from '../non-task-provider-usage';

export const FAST_AGENT_TRANSCRIPT_IMAGE_MAX_MESSAGES = 12;
const FAST_AGENT_TRANSCRIPT_IMAGE_MAX_IMAGES = 20;
const FAST_AGENT_TRANSCRIPT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const FAST_AGENT_TRANSCRIPT_IMAGE_MAX_INSPECTION = 8;

export type FastAgentTranscriptImage = {
  id: string;
  eventId: string;
  turnId: string;
  imageIndex: number;
  ts: number;
  turnSeq: number;
  messageText: string;
  file: NonTaskPromptFile;
  byteSize: number;
};

export type FastAgentTranscriptImageRow = {
  eventId: string;
  turnId: string;
  ts: number;
  turnSeq: number;
  contentBlocks: TaskMessageContentBlock[];
};

export function encodeFastAgentTranscriptImageId(
  eventId: string,
  imageIndex: number,
): string {
  return `img_${Buffer.from(eventId, 'utf8').toString('base64url')}_${imageIndex}`;
}

export function parseFastAgentTranscriptImageId(
  id: string,
): { eventId: string; imageIndex: number } | null {
  const match =
    /^img_([A-Za-z0-9_-]+)_(\d+)$/u.exec(id) ??
    /^image:([A-Za-z0-9_-]+):(\d+)$/u.exec(id);
  if (!match?.[1] || !match[2]) return null;

  const imageIndex = Number(match[2]);
  if (!Number.isSafeInteger(imageIndex) || imageIndex < 1) return null;

  try {
    const eventId = Buffer.from(match[1], 'base64url').toString('utf8');
    if (
      !eventId ||
      Buffer.from(eventId, 'utf8').toString('base64url') !== match[1]
    ) {
      return null;
    }
    return { eventId, imageIndex };
  } catch {
    return null;
  }
}

function base64ByteSize(data: string): number {
  const normalized = data.replace(/\s/gu, '');
  const padding = normalized.endsWith('==')
    ? 2
    : normalized.endsWith('=')
      ? 1
      : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function transcriptImagesFromRow(
  row: FastAgentTranscriptImageRow,
): FastAgentTranscriptImage[] {
  const messageText = row.contentBlocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  let imageIndex = 0;

  return row.contentBlocks.flatMap((block) => {
    if (
      block.type !== 'image' ||
      typeof block.mimeType !== 'string' ||
      !block.mimeType.startsWith('image/') ||
      typeof block.data !== 'string' ||
      !block.data
    ) {
      return [];
    }

    imageIndex += 1;
    return [
      {
        id: encodeFastAgentTranscriptImageId(row.eventId, imageIndex),
        eventId: row.eventId,
        turnId: row.turnId,
        imageIndex,
        ts: row.ts,
        turnSeq: row.turnSeq,
        messageText,
        file: {
          mime: block.mimeType,
          url: `data:${block.mimeType};base64,${block.data}`,
        },
        byteSize: base64ByteSize(block.data),
      },
    ];
  });
}

export function selectBoundedFastAgentTranscriptImages(
  rowsNewestFirst: FastAgentTranscriptImageRow[],
): { images: FastAgentTranscriptImage[]; truncated: boolean } {
  const selected: FastAgentTranscriptImage[] = [];
  let selectedBytes = 0;
  let truncated =
    rowsNewestFirst.length > FAST_AGENT_TRANSCRIPT_IMAGE_MAX_MESSAGES;

  for (const row of rowsNewestFirst.slice(
    0,
    FAST_AGENT_TRANSCRIPT_IMAGE_MAX_MESSAGES,
  )) {
    for (const image of transcriptImagesFromRow(row)) {
      if (
        selected.length >= FAST_AGENT_TRANSCRIPT_IMAGE_MAX_IMAGES ||
        selectedBytes + image.byteSize > FAST_AGENT_TRANSCRIPT_IMAGE_MAX_BYTES
      ) {
        truncated = true;
        continue;
      }
      selected.push(image);
      selectedBytes += image.byteSize;
    }
  }

  selected.sort(
    (left, right) =>
      left.ts - right.ts ||
      left.turnSeq - right.turnSeq ||
      left.imageIndex - right.imageIndex,
  );
  return { images: selected, truncated };
}

function messageLabel(image: FastAgentTranscriptImage): string {
  const text = image.messageText.replace(/\s+/gu, ' ').trim();
  const excerpt = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return excerpt
    ? `message ${image.turnId} ("${excerpt.replaceAll('"', '\\"')}")`
    : `message ${image.turnId}`;
}

export function buildFastAgentTranscriptImageNotice(
  images: FastAgentTranscriptImage[],
  delivery: 'direct' | 'helper' | 'unsupported',
  options?: { truncated?: boolean },
): string {
  const groups = new Map<
    string,
    { label: string; images: FastAgentTranscriptImage[] }
  >();
  for (const image of images) {
    const group = groups.get(image.eventId);
    if (group) group.images.push(image);
    else
      groups.set(image.eventId, {
        label: messageLabel(image),
        images: [image],
      });
  }

  const attachments = [...groups.values()]
    .map(
      ({ label, images: groupImages }) =>
        `- ${label}: ${groupImages
          .map((image) => `${image.id} (${image.file.mime})`)
          .join(', ')}`,
    )
    .join('\n');
  const truncation = options?.truncated
    ? '\n- Older or oversized images were omitted from this bounded transcript view.'
    : '';
  const instruction =
    delivery === 'helper'
      ? 'The current model cannot view these images directly. Call inspect_images with a targeted question and explicit IDs when more than one image could apply.'
      : delivery === 'unsupported'
        ? 'No configured model accepts image input, so these images cannot be viewed. Tell the user plainly and answer from text only.'
        : 'These images are attached to this reconstructed prompt in the same order. Their IDs preserve the original message association.';

  return `[Images in the conversation transcript:\n${attachments}${truncation}\n${instruction}]`;
}
