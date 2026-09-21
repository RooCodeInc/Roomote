import { Buffer } from 'node:buffer';

import {
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  getImageUrisFromContentBlocks,
  getTextFromContentBlocks,
  resolveAcpTranscriptVisibility,
  sanitizeEnvelopeFields,
  type TaskMessageContentBlock,
  type TaskMessageEventType,
  type RoomoteTranscriptMessage,
  type RoomoteTranscriptMessagesCoverage,
} from '@roomote/types';

import type {
  MessageHistoryPosition,
  MessageHistorySnapshot,
} from './message-history-pagination';

const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 1000;
const MAX_MESSAGE_PAGE_BYTES = 256_000;
const MAX_MESSAGE_SCAN_ROWS = 10_000;
const MAX_MESSAGE_TEXT_CHARS = ACP_UI_TOOL_OUTPUT_MAX_CHARS;
const MAX_MESSAGE_IMAGE_URI_CHARS = 64_000;

export type MessageHistoryRow = {
  id: string;
  taskId: string;
  ts: number;
  turnSeq?: number;
  eventType: TaskMessageEventType;
  role: RoomoteTranscriptMessage['role'];
  contentBlocks: TaskMessageContentBlock[];
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export function parseMessageLimit(value: string | undefined): number | null {
  const parsed = Number(value ?? DEFAULT_MESSAGE_LIMIT);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_MESSAGE_LIMIT);
}

function positionForMessageRow(
  row: Pick<MessageHistoryRow, 'id' | 'ts' | 'turnSeq' | 'createdAt'>,
): MessageHistoryPosition {
  return {
    ts: Number(row.ts),
    ...(row.turnSeq === undefined ? {} : { turnSeq: row.turnSeq }),
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
}

export function snapshotForMessageRow(
  row: Pick<MessageHistoryRow, 'id' | 'createdAt'>,
): MessageHistorySnapshot {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
}

function truncateMessageContent(
  message: RoomoteTranscriptMessage,
): RoomoteTranscriptMessage {
  const textWasTruncated =
    message.text !== null && message.text.length > MAX_MESSAGE_TEXT_CHARS;
  const text = textWasTruncated
    ? `${message.text?.slice(0, MAX_MESSAGE_TEXT_CHARS)}...`
    : message.text;
  const images = message.images.filter(
    (image) => Buffer.byteLength(image, 'utf8') <= MAX_MESSAGE_IMAGE_URI_CHARS,
  );
  const imagesWereTruncated = images.length !== message.images.length;

  return {
    ...message,
    text,
    images,
    ...(textWasTruncated || imagesWereTruncated ? { truncated: true } : {}),
  };
}

function serializeMessage(
  row: MessageHistoryRow,
): RoomoteTranscriptMessage | null {
  const visibleInTranscript = resolveAcpTranscriptVisibility({
    eventType: row.eventType,
    contentBlocks: row.contentBlocks,
    metadata: row.metadata,
    payload: row.payload,
  });
  if (!visibleInTranscript) return null;

  const sanitized = sanitizeEnvelopeFields(
    row.eventType,
    row.contentBlocks,
    row.metadata,
    row.payload,
    { maxOutputChars: ACP_UI_TOOL_OUTPUT_MAX_CHARS },
  );
  return truncateMessageContent({
    id: row.id,
    taskId: row.taskId,
    ts: Number(row.ts),
    eventType: row.eventType,
    role: row.role,
    text: getTextFromContentBlocks(sanitized.contentBlocks),
    images: getImageUrisFromContentBlocks(sanitized.contentBlocks),
    metadata: sanitized.metadata,
    visibleInTranscript: true,
  });
}

function minimalMessageForSize(
  message: RoomoteTranscriptMessage,
): RoomoteTranscriptMessage {
  return {
    ...message,
    text: message.text?.slice(0, 2_000) ?? null,
    images: [],
    metadata: null,
    truncated: true,
  };
}

function messageBytes(message: RoomoteTranscriptMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

export function coverageForMessages(
  messages: RoomoteTranscriptMessage[],
  hasMore: boolean,
): RoomoteTranscriptMessagesCoverage {
  if (messages.length === 0) {
    return { complete: !hasMore, newestTs: null, oldestTs: null };
  }

  const timestamps = messages.map((message) => message.ts);
  return {
    complete: !hasMore,
    newestTs: Math.max(...timestamps),
    oldestTs: Math.min(...timestamps),
  };
}

interface CollectedMessagePage {
  messages: RoomoteTranscriptMessage[];
  hasMore: boolean;
  truncated: boolean;
  nextPosition: MessageHistoryPosition | null;
}

export async function collectMessagePage(params: {
  limit: number;
  initialPosition: MessageHistoryPosition | null;
  loadRows: (
    position: MessageHistoryPosition | null,
    batchSize: number,
  ) => Promise<MessageHistoryRow[]>;
}): Promise<CollectedMessagePage> {
  const messages: RoomoteTranscriptMessage[] = [];
  let responseBytes = 0;
  let scannedRows = 0;
  let scanPosition = params.initialPosition;
  let lastReturnedPosition = params.initialPosition;
  let hasMore = false;
  let truncated = false;

  while (scannedRows < MAX_MESSAGE_SCAN_ROWS) {
    const batchSize = Math.min(
      Math.max(params.limit + 1, 100),
      MAX_MESSAGE_SCAN_ROWS - scannedRows,
    );
    const rows = await params.loadRows(scanPosition, batchSize);
    scannedRows += rows.length;
    if (rows.length === 0) break;

    for (const row of rows) {
      scanPosition = positionForMessageRow(row);
      const message = serializeMessage(row);
      if (!message) continue;
      if (messages.length >= params.limit) {
        hasMore = true;
        break;
      }
      if (message.truncated) truncated = true;

      let boundedMessage = message;
      let bytes = messageBytes(boundedMessage);
      if (responseBytes > 0 && responseBytes + bytes > MAX_MESSAGE_PAGE_BYTES) {
        hasMore = true;
        truncated = true;
        break;
      }
      if (responseBytes === 0 && bytes > MAX_MESSAGE_PAGE_BYTES) {
        boundedMessage = minimalMessageForSize(message);
        bytes = messageBytes(boundedMessage);
        truncated = true;
      }
      messages.push(boundedMessage);
      responseBytes += bytes;
      lastReturnedPosition = positionForMessageRow(row);
    }

    if (hasMore || rows.length < batchSize) break;
  }

  if (!hasMore && scannedRows >= MAX_MESSAGE_SCAN_ROWS) {
    hasMore = true;
    truncated = true;
  }

  return {
    messages,
    hasMore,
    truncated,
    nextPosition: messages.length > 0 ? lastReturnedPosition : scanPosition,
  };
}
