import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { decrypt } from '@roomote/db/encryption';
import {
  acceptAutomationWebhookDelivery,
  automationWebhookTriggers,
  db,
  eq,
} from '@roomote/db/server';

const eventSchema = z
  .object({
    event_id: z.string().min(1).max(256),
    event_type: z.enum([
      'note.generated',
      'note.edited',
      'note.access_granted',
    ]),
    note_id: z.string().regex(/^not_[a-zA-Z0-9]{14}$/),
    occurred_at: z.string().datetime({ offset: true }),
    data: z
      .object({ changed_fields: z.array(z.literal('summary')).optional() })
      .optional(),
  })
  .superRefine((event, ctx) => {
    if (
      event.event_type === 'note.edited' &&
      !event.data?.changed_fields?.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Missing changed fields',
      });
    }
  });

export const automationWebhooks = new Hono();

automationWebhooks.post(
  '/:triggerId',
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
  async (c) => {
    const triggerId = c.req.param('triggerId');
    if (!z.string().uuid().safeParse(triggerId).success) {
      return c.json({ error: 'invalid_trigger' }, 400);
    }

    try {
      const [trigger] = await db
        .select()
        .from(automationWebhookTriggers)
        .where(eq(automationWebhookTriggers.id, triggerId))
        .limit(1);
      if (
        !trigger ||
        trigger.provider !== 'granola' ||
        !trigger.encryptedSigningSecret
      ) {
        return c.json({ error: 'invalid_signature' }, 401);
      }

      const id = c.req.header('webhook-id');
      const timestamp = c.req.header('webhook-timestamp');
      const signatures = c.req.header('webhook-signature');
      if (
        !id ||
        !timestamp ||
        !signatures ||
        !/^\d+$/.test(timestamp) ||
        !Number.isSafeInteger(Number(timestamp)) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
      ) {
        return c.json({ error: 'invalid_signature' }, 401);
      }

      // encryptedText returns ciphertext. Decrypt before decoding the Standard
      // Webhooks whsec_ key; neither printable value is the HMAC key itself.
      const secret = decrypt(trigger.encryptedSigningSecret);
      if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) {
        return c.json({ error: 'unavailable' }, 503);
      }
      const rawBody = Buffer.from(await c.req.arrayBuffer());
      const expected = createHmac(
        'sha256',
        Buffer.from(secret.slice(6), 'base64'),
      )
        .update(`${id}.${timestamp}.`)
        .update(rawBody)
        .digest();
      let verified = false;
      for (const signature of signatures.split(/\s+/)) {
        if (!/^v1,[A-Za-z0-9+/]+={0,2}$/.test(signature)) continue;
        const candidate = Buffer.from(signature.slice(3), 'base64');
        if (candidate.length === expected.length) {
          verified = timingSafeEqual(expected, candidate) || verified;
        }
      }
      if (!verified) return c.json({ error: 'invalid_signature' }, 401);

      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(rawBody),
        );
      } catch {
        return c.json({ error: 'invalid_payload' }, 400);
      }
      // Provider metadata is allowed but stripped. Only the identity envelope
      // below crosses the durable boundary; never store note content or raw JSON.
      const parsed = eventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.event_id !== id) {
        return c.json({ error: 'invalid_payload' }, 400);
      }
      const event = parsed.data;
      // The transaction deduplicates before rechecking active/enabled gates.
      // No execution is started in the request, even for a newly accepted event.
      const result = await acceptAutomationWebhookDelivery({
        triggerId,
        eventId: event.event_id,
        eventType: event.event_type,
        noteId: event.note_id,
        occurredAt: new Date(event.occurred_at),
      });
      if (result === 'capacity') return c.json({ error: 'capacity' }, 429);
      return c.json({ status: result }, 200);
    } catch {
      // DB and decryption errors may carry SQL parameters or secrets.
      return c.json({ error: 'unavailable' }, 503);
    }
  },
);
