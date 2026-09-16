import { Hono } from 'hono';

import type { Variables } from '../../types';
import {
  executePublicUrlFetch,
  PublicUrlFetchToolError,
} from './roomote-public-url-fetch';

export const publicUrlFetchRoute = new Hono<{ Variables: Variables }>();

publicUrlFetchRoute.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'A valid public URL is required.' }, 400);
  }

  try {
    return c.json(await executePublicUrlFetch(body, c.req.raw.signal));
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof PublicUrlFetchToolError
            ? error.message
            : 'Public URL fetch failed.',
      },
      400,
    );
  }
});
