import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createMondayAgentResponse,
  createMondayWebhookDeliveryId,
  isMondayWebhookTimestampFresh,
  parseMondayWebhook,
  verifyMondayWebhookSignature,
} from './webhook';

describe('monday.com agent webhooks', () => {
  it('verifies the timestamp and raw body with HMAC-SHA256', () => {
    const rawBody = '{"event":"agent_triggered"}';
    const timestamp = '1785427200000';
    const signingSecret = 'secret';
    const signature = `sha256=${crypto
      .createHmac('sha256', signingSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex')}`;

    expect(
      verifyMondayWebhookSignature({
        rawBody,
        timestamp,
        signingSecret,
        signature,
      }),
    ).toBe(true);
    expect(
      verifyMondayWebhookSignature({
        rawBody: `${rawBody} `,
        timestamp,
        signingSecret,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects stale, future, and malformed timestamps', () => {
    const now = 1_785_427_200_000;
    expect(isMondayWebhookTimestampFresh(String(now), now)).toBe(true);
    expect(isMondayWebhookTimestampFresh(String(now - 300_001), now)).toBe(
      false,
    );
    expect(isMondayWebhookTimestampFresh(String(now + 300_001), now)).toBe(
      false,
    );
    expect(isMondayWebhookTimestampFresh('not-a-time', now)).toBe(false);
  });

  it('creates stable delivery ids and parses only supported triggers', () => {
    expect(
      createMondayWebhookDeliveryId({
        agentId: 'agent-1',
        timestamp: '123',
        rawBody: '{}',
      }),
    ).toBe(
      createMondayWebhookDeliveryId({
        agentId: 'agent-1',
        timestamp: '123',
        rawBody: '{}',
      }),
    );

    expect(
      parseMondayWebhook({
        event: 'agent_triggered',
        triggerType: 'assigned',
        payload: {
          text: 'Assigned',
          itemId: 12,
          boardId: 34,
          groupId: 'topics',
          updateId: null,
          replyId: null,
          updateBody: null,
          files: null,
        },
        timestamp: '2026-07-30T00:00:00.000Z',
      }),
    ).toMatchObject({
      type: 'trigger',
      trigger: { payload: { itemId: '12', boardId: '34' } },
    });
    expect(() =>
      parseMondayWebhook({
        event: 'agent_triggered',
        triggerType: 'unknown',
        payload: { text: 'No target' },
        timestamp: '2026-07-30T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('formats streaming and non-streaming replies', () => {
    expect(createMondayAgentResponse('Not active yet')).toEqual({
      body: 'data: {"type":"text","content":"Not active yet"}\n\ndata: [DONE]\n\n',
      contentType: 'text/event-stream',
    });
    expect(createMondayAgentResponse('Not active yet', false)).toEqual({
      body: '{"message":"Not active yet"}',
      contentType: 'application/json',
    });
  });
});
