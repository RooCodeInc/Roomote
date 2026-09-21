import { z } from 'zod';

export type MessageHistoryTarget = {
  kind: 'task' | 'session';
  id: string;
};

export type MessageHistoryPosition = {
  ts: number;
  turnSeq?: number;
  createdAt: string;
  id: string;
};

export type MessageHistorySnapshot = {
  createdAt: string;
  id: string;
};

export type MessageHistoryCursor = {
  version: 1;
  target: MessageHistoryTarget;
  order: 'asc' | 'desc';
  snapshot: MessageHistorySnapshot;
  position: MessageHistoryPosition;
};

export const MESSAGE_HISTORY_CURSOR_MAX_LENGTH = 4096;

const uuidSchema = z.string().uuid();

function isValidDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isValidPosition(value: unknown): value is MessageHistoryPosition {
  if (!value || typeof value !== 'object') return false;
  const position = value as Partial<MessageHistoryPosition>;
  return (
    typeof position.ts === 'number' &&
    Number.isFinite(position.ts) &&
    isValidDate(position.createdAt) &&
    uuidSchema.safeParse(position.id).success &&
    (position.turnSeq === undefined ||
      (Number.isSafeInteger(position.turnSeq) && position.turnSeq >= 0))
  );
}

function isValidSnapshot(value: unknown): value is MessageHistorySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<MessageHistorySnapshot>;
  return (
    isValidDate(snapshot.createdAt) && uuidSchema.safeParse(snapshot.id).success
  );
}

export function encodeMessageHistoryCursor(
  cursor: MessageHistoryCursor,
): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeMessageHistoryCursor(params: {
  value: string | undefined;
  target: MessageHistoryTarget;
  order: 'asc' | 'desc';
}): MessageHistoryCursor | null {
  const value = params.value;
  if (!value) return null;
  if (value.length > MESSAGE_HISTORY_CURSOR_MAX_LENGTH) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<MessageHistoryCursor>;
    if (
      parsed.version !== 1 ||
      parsed.order !== params.order ||
      parsed.target?.kind !== params.target.kind ||
      parsed.target.id !== params.target.id ||
      !isValidSnapshot(parsed.snapshot) ||
      !isValidPosition(parsed.position)
    ) {
      return null;
    }

    return parsed as MessageHistoryCursor;
  } catch {
    return null;
  }
}
