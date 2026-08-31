import { Hono } from 'hono';

import {
  getDiscordRequestUserInputCurrentQuestion,
  getPendingCommunicationRequestUserInput,
  submitPendingCommunicationRequestUserInputAnswer,
} from '@roomote/communication';
import { setTrustedRunActingUserOnSuccess } from '@roomote/db/server';
import {
  recordAgentMailWebhookEvent,
  verifyAgentMailRuiAnswerToken,
} from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import { verifyAgentMailWebhook } from './webhook-gate.js';

export const agentmail = new Hono();

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function answerPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1b2430"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p style="color:#5b6675">${escapeHtml(detail)}</p></body></html>`;
}

/**
 * One-click request_user_input answer links from question emails. The token
 * is signed and was delivered to the responder's mailbox (magic-link trust);
 * the claim itself still goes through the atomic pending → submitted
 * transition, so double clicks and stale links resolve safely.
 */
agentmail.get('/answer', async (c) => {
  const token = c.req.query('token');
  const payload = token ? verifyAgentMailRuiAnswerToken(token) : null;

  if (!payload) {
    return c.html(
      answerPage(
        'This link is no longer valid',
        'The answer link is malformed or has expired. Reply to the question email instead.',
      ),
      400,
    );
  }

  const pendingRequest = await getPendingCommunicationRequestUserInput(
    'agentmail',
    payload.conversationId,
  );
  if (!pendingRequest || pendingRequest.requestId !== payload.requestId) {
    return c.html(
      answerPage(
        'This question is no longer active',
        'The task has moved on. If it still needs input, it will email you again.',
      ),
    );
  }
  if (pendingRequest.status === 'submitted') {
    return c.html(
      answerPage(
        'Already answered',
        'An answer for this question was already recorded.',
      ),
    );
  }

  const current = getDiscordRequestUserInputCurrentQuestion(pendingRequest);
  const option =
    current && current.question.id === payload.questionId
      ? current.question.options?.[payload.optionIndex]
      : undefined;
  if (!current || !option) {
    return c.html(
      answerPage(
        'That option is no longer available',
        'The question has changed since this email was sent. Reply to the latest question email instead.',
      ),
    );
  }

  const queued = await setTrustedRunActingUserOnSuccess({
    runId: pendingRequest.runId,
    userId: payload.userId,
    operation: async () =>
      submitPendingCommunicationRequestUserInputAnswer(
        'agentmail',
        payload.conversationId,
        pendingRequest,
        {
          answers: {
            [current.question.id]: { answers: [option.label] },
          },
          userId: payload.userId,
          timestamp: Date.now(),
        },
      ),
  });

  if (!queued) {
    return c.html(
      answerPage(
        'Already answered',
        'An answer for this question was already recorded.',
      ),
    );
  }

  return c.html(
    answerPage(
      `Answer recorded: ${option.label}`,
      'Roomote will continue and reply in the email thread. You can close this tab.',
    ),
  );
});

/**
 * Inbound AgentMail webhook. The contract with the durable ingestion
 * pipeline: verify the Svix signature over the raw body, record the delivery
 * in the `agentmail_webhook_events` outbox, dispatch its processing job, and
 * only then return 200. Processing (sender resolution, conversation routing,
 * Fast admission) happens asynchronously from the BullMQ queue; a crash after
 * this 200 can never lose an email because the outbox row is the commitment.
 */
agentmail.post('/', async (c) => {
  const rawBody = await c.req.text();

  const verification = await verifyAgentMailWebhook({
    rawBody,
    headers: {
      svixId: c.req.header('svix-id'),
      svixTimestamp: c.req.header('svix-timestamp'),
      svixSignature: c.req.header('svix-signature'),
    },
  });

  if (!verification.ok) {
    return c.json(
      { ok: false, error: verification.error },
      verification.status,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const eventType =
    payload && typeof payload === 'object' && 'event_type' in payload
      ? String((payload as { event_type: unknown }).event_type)
      : '';
  const eventId =
    payload && typeof payload === 'object' && 'event_id' in payload
      ? String((payload as { event_id: unknown }).event_id)
      : null;

  const result = await recordAgentMailWebhookEvent({
    deliveryId: verification.deliveryId,
    eventId,
    eventType,
    payload,
  });

  if (!result.accepted) {
    return c.json({ ok: true, ignored: result.reason });
  }

  if (result.duplicate) {
    apiLogger.debug(
      `[agentmail] Duplicate delivery ${verification.deliveryId} acknowledged`,
    );
  }

  return c.json({ ok: true, queued: true, duplicate: result.duplicate });
});
