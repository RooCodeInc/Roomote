import crypto from 'node:crypto';

import {
  mondayAgentTriggerSchema,
  mondayWebhookChallengeSchema,
  type MondayAgentTrigger,
} from './types';

export const MONDAY_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const MONDAY_WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

export function isMondayWebhookTimestampFresh(
  timestamp: string,
  now = Date.now(),
  maxAgeMs = MONDAY_WEBHOOK_MAX_AGE_MS,
): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const timestampMs = Number(timestamp);
  return (
    Number.isSafeInteger(timestampMs) && Math.abs(now - timestampMs) <= maxAgeMs
  );
}

export function verifyMondayWebhookSignature(input: {
  rawBody: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
}): boolean {
  const expected = `sha256=${crypto
    .createHmac('sha256', input.signingSecret)
    .update(`${input.timestamp}.${input.rawBody}`)
    .digest('hex')}`;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(input.signature);

  return (
    expectedBytes.length === actualBytes.length &&
    crypto.timingSafeEqual(expectedBytes, actualBytes)
  );
}

export function createMondayWebhookDeliveryId(input: {
  agentId: string;
  timestamp: string;
  rawBody: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(`${input.agentId}.${input.timestamp}.${input.rawBody}`)
    .digest('hex');
}

export type ParsedMondayWebhook =
  | { type: 'challenge'; challenge: string }
  | { type: 'trigger'; trigger: MondayAgentTrigger };

export function parseMondayWebhook(body: unknown): ParsedMondayWebhook {
  const challenge = mondayWebhookChallengeSchema.safeParse(body);
  if (challenge.success) {
    return { type: 'challenge', challenge: challenge.data.challenge };
  }

  const trigger = mondayAgentTriggerSchema.parse(body);
  return { type: 'trigger', trigger };
}

export type MondayWebhookResponse = {
  body: string;
  contentType: 'application/json' | 'text/event-stream';
};

export function createMondayAgentResponse(
  message: string,
  stream = true,
): MondayWebhookResponse {
  if (!stream) {
    return {
      body: JSON.stringify({ message }),
      contentType: 'application/json',
    };
  }

  return {
    body: `data: ${JSON.stringify({ type: 'text', content: message })}\n\ndata: [DONE]\n\n`,
    contentType: 'text/event-stream',
  };
}
