import type { Context } from 'hono';
import {
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES,
} from '@roomote/cloud-agents/server/non-task-provider-usage';
import { formatSingleLineLog } from '@roomote/types';

import type { Variables } from '../../types';
import {
  HELPER_SYNTHESIS_DEFAULT_MAX_OUTPUT_TOKENS,
  HELPER_SYNTHESIS_TIMEOUT_MS,
  LOG_PREFIX,
} from './constants';
import { helperChatJson, helperResponsesJson } from './helper-answer-json';
import { jsonResponseInstruction, toHelperPromptParts } from './helper-prompt';
import { responsesHelperBody } from './helper-responses';

type GatewayContext = Context<{ Variables: Variables }>;

export async function answerWithHelperModel(
  c: GatewayContext,
  body: Record<string, unknown>,
  isResponses: boolean,
): Promise<Response> {
  if (body.stream === true) {
    return c.json(
      {
        error:
          'The Brain helper model does not support streaming. Retry without stream.',
      },
      400,
    );
  }

  const helperBody = isResponses ? responsesHelperBody(body) : body;
  if (!helperBody) {
    return c.json(
      {
        error:
          'The Brain helper model supports text-only Responses input without tools or previous responses.',
      },
      400,
    );
  }

  const { system, prompt } = toHelperPromptParts(helperBody.messages);
  const jsonInstruction = jsonResponseInstruction(helperBody.response_format);
  const systemWithFormat = [system, jsonInstruction]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');

  try {
    const text = await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.brainSynthesis,
      modelRole: 'small',
      system: systemWithFormat || undefined,
      prompt,
      maxOutputTokens: helperMaxTokens(helperBody.max_tokens),
      timeoutMs: HELPER_SYNTHESIS_TIMEOUT_MS,
    });

    return isResponses ? helperResponsesJson(c, text) : helperChatJson(c, text);
  } catch (error) {
    const detail = (
      error instanceof Error ? error.message : String(error)
    ).replace(/\s+/g, ' ');

    console.warn(
      formatSingleLineLog(`${LOG_PREFIX} Helper synthesis failed`, {
        error: detail,
      }),
    );

    return c.json({ error: 'Brain helper-model synthesis failed' }, 502);
  }
}

function helperMaxTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : HELPER_SYNTHESIS_DEFAULT_MAX_OUTPUT_TOKENS;
}
