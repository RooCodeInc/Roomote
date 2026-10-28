import { randomUUID } from 'node:crypto';

import type { Context } from 'hono';

import type { Variables } from '../../types';
import { BRAIN_HELPER_MODEL_ID } from './constants';

type GatewayContext = Context<{ Variables: Variables }>;

export function helperChatJson(c: GatewayContext, text: string): Response {
  return c.json({
    id: `brain-helper-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: BRAIN_HELPER_MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

export function helperResponsesJson(c: GatewayContext, text: string): Response {
  return c.json({
    id: `resp_${randomUUID()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: BRAIN_HELPER_MODEL_ID,
    error: null,
    incomplete_details: null,
    output: [
      {
        id: `msg_${randomUUID()}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });
}
