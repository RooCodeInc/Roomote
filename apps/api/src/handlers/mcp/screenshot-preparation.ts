import { Hono } from 'hono';

import { Env } from '@roomote/env';
import {
  screenshotPreparationInputSchema,
  type ScreenshotPreparationInput,
} from '@roomote/types';
import { prepareScreenshotStep } from '@roomote/cloud-agents/server/screenshot-preparation';

import type { Variables } from '../../types';
import type { McpAuth } from './middleware';

export const screenshotPreparationRoute = new Hono<{
  Variables: Variables & { mcpAuth: McpAuth };
}>();

screenshotPreparationRoute.post('/', async (c) => {
  const auth = c.get('mcpAuth');

  if (auth.authContext.tokenType !== 'run' || !auth.authContext.runId) {
    return c.json(
      { error: 'Screenshot preparation requires a task run token.' },
      403,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'A valid screenshot preparation request is required.' },
      400,
    );
  }

  const parsed = screenshotPreparationInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues.map((issue) => issue.message).join(' ') },
      400,
    );
  }

  const result = await prepareScreenshotStep({
    runId: String(auth.authContext.runId),
    input: parsed.data as ScreenshotPreparationInput,
    enabled: Env.R_SCREENSHOT_PREPARATION_JEV_ENABLED,
  });

  return c.json(result);
});
