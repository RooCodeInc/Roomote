import {
  type AcpMessage,
  asFiniteNumber as asNumber,
  asRecord,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

export interface AcpContextUsage {
  usedTokens: number;
  maxTokens: number;
  updatedAt: number;
}

function parseAcpUsage(
  usedValue: unknown,
  maxValue: unknown,
  updatedAt: number,
): AcpContextUsage | null {
  const usedTokens = asNumber(usedValue);
  const maxTokens = asNumber(maxValue);

  if (usedTokens === undefined || maxTokens === undefined || maxTokens <= 0) {
    return null;
  }

  return {
    usedTokens: Math.max(0, usedTokens),
    maxTokens,
    updatedAt,
  };
}

export function parseAcpUsageFromOutputEvent(
  event: AcpMessage,
): AcpContextUsage | null {
  if (event.eventType !== 'roomote_runtime.usage_update') {
    return null;
  }

  const payload = asRecord(event.payload);

  return parseAcpUsage(payload?.used, payload?.size, event.ts);
}

export function parseAcpUsageFromEnvelope(
  envelope: TaskMessageEnvelope,
): AcpContextUsage | null {
  const payload = asRecord(envelope.payload);

  if (!payload) {
    return null;
  }

  const updateType = payload.updateType;
  const update = asRecord(payload.update);

  if (
    updateType !== 'usage_update' &&
    update?.sessionUpdate !== 'usage_update'
  ) {
    return null;
  }

  const metadata = asRecord(envelope.metadata);

  const updatedAt =
    asNumber(payload.receivedAt) ??
    asNumber(metadata?.receivedAt) ??
    envelope.ts;

  return parseAcpUsage(
    update?.used ?? payload.used,
    update?.size ?? payload.size,
    updatedAt,
  );
}
