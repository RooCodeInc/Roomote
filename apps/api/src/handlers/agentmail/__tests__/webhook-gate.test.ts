import { Webhook } from 'svix';

import { verifyAgentMailWebhook } from '../webhook-gate.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

describe('verifyAgentMailWebhook', () => {
  beforeAll(() => {
    process.env.R_AGENTMAIL_WEBHOOK_SECRET = SECRET;
    process.env.R_AGENTMAIL_API_KEY = 'am_test_key';
  });

  function sign(rawBody: string, msgId = 'msg_test_1') {
    const timestamp = new Date();
    const signature = new Webhook(SECRET).sign(msgId, timestamp, rawBody);
    return {
      svixId: msgId,
      svixTimestamp: String(Math.floor(timestamp.getTime() / 1000)),
      svixSignature: signature,
    };
  }

  it('accepts a correctly signed delivery', async () => {
    const rawBody = JSON.stringify({ event_type: 'message.received' });
    const result = await verifyAgentMailWebhook({
      rawBody,
      headers: sign(rawBody),
    });
    expect(result).toEqual({ ok: true, deliveryId: 'msg_test_1' });
  });

  it('rejects a tampered body', async () => {
    const rawBody = JSON.stringify({ event_type: 'message.received' });
    const headers = sign(rawBody);
    const result = await verifyAgentMailWebhook({
      rawBody: `${rawBody} `,
      headers,
    });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a stale timestamp outside the replay window', async () => {
    const rawBody = JSON.stringify({ event_type: 'message.received' });
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const signature = new Webhook(SECRET).sign('msg_old', stale, rawBody);
    const result = await verifyAgentMailWebhook({
      rawBody,
      headers: {
        svixId: 'msg_old',
        svixTimestamp: String(Math.floor(stale.getTime() / 1000)),
        svixSignature: signature,
      },
    });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects missing signature headers', async () => {
    const result = await verifyAgentMailWebhook({
      rawBody: '{}',
      headers: {
        svixId: undefined,
        svixTimestamp: undefined,
        svixSignature: undefined,
      },
    });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});
