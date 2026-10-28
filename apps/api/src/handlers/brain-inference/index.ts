import { Hono } from 'hono';

import { formatSingleLineLog } from '@roomote/types';
import { getBrainGatewayToken } from '@roomote/sdk/server';

import type { Variables } from '../../types';
import { presentedToken, tokenMatches } from './auth';
import {
  BRAIN_ALLOWED_PATHS,
  BRAIN_HELPER_MODEL_ID,
  LOG_PREFIX,
} from './constants';
import { forwardLocalEmbeddings } from './forward-local';
import { forwardProviderInference } from './forward-provider';
import { maybeAnswerChatWithHelper } from './maybe-helper';

export { BRAIN_HELPER_MODEL_ID };

/**
 * Inference gateway for this deployment's Brain.
 *
 * The Brain container holds no provider credential. It is pointed at this
 * route with a shared gateway token, and Roomote injects whichever provider
 * key an admin configured, resolved per request.
 */
export const brainInference = new Hono<{ Variables: Variables }>();

brainInference.post('/*', async (c) => {
  const expectedToken = getBrainGatewayToken();

  if (!expectedToken) {
    return c.json({ error: 'The Brain inference gateway is not enabled' }, 404);
  }

  const presented = presentedToken(c.req.header('authorization'));

  if (!presented || !tokenMatches(presented, expectedToken)) {
    return c.json({ error: 'Invalid Brain gateway token' }, 401);
  }

  const requestUrl = new URL(c.req.url);
  const upstreamPath = requestUrl.pathname.replace(
    /^\/api\/brain\/inference/,
    '',
  );

  if (!BRAIN_ALLOWED_PATHS.has(upstreamPath)) {
    console.warn(
      formatSingleLineLog(`${LOG_PREFIX} Rejected disallowed path`, {
        upstreamPath,
      }),
    );

    return c.json({ error: 'Path is not allowed through this gateway' }, 403);
  }

  const helperResult = await maybeAnswerChatWithHelper(c, upstreamPath);

  if (helperResult instanceof Response) {
    return helperResult;
  }

  const local = await forwardLocalEmbeddings(c, upstreamPath, requestUrl);

  if (local) {
    return local;
  }

  return forwardProviderInference(
    c,
    upstreamPath,
    requestUrl,
    helperResult?.helperOverrideBody,
  );
});
