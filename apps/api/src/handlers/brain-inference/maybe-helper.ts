import type { Context } from 'hono';
import { Env } from '@roomote/env';
import { resolveBrainInferenceProvider } from '@roomote/sdk/server';

import type { Variables } from '../../types';
import { BRAIN_HELPER_MODEL_ID } from './constants';
import { answerWithHelperModel } from './helper-answer';

type GatewayContext = Context<{ Variables: Variables }>;

export async function maybeAnswerChatWithHelper(
  c: GatewayContext,
  upstreamPath: string,
): Promise<Response | { helperOverrideBody?: string } | null> {
  const isResponses = upstreamPath === '/v1/responses';
  if (upstreamPath !== '/v1/chat/completions' && !isResponses) {
    return null;
  }

  let parsedBody: Record<string, unknown> | undefined;

  try {
    const candidate = JSON.parse(await c.req.text()) as unknown;
    parsedBody =
      candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : undefined;
  } catch {
    // Not JSON we understand; the provider path forwards it untouched.
  }

  if (parsedBody?.model === BRAIN_HELPER_MODEL_ID) {
    const overrideModel = Env.R_BRAIN_MODEL?.trim();

    if (overrideModel) {
      return {
        helperOverrideBody: JSON.stringify({
          ...parsedBody,
          model: overrideModel,
        }),
      };
    }

    return answerWithHelperModel(c, parsedBody, isResponses);
  }

  if (parsedBody && !(await resolveBrainInferenceProvider())) {
    return answerWithHelperModel(c, parsedBody, isResponses);
  }

  return {};
}
