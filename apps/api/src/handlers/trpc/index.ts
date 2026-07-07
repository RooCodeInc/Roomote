import { Hono, type Context } from 'hono';
import { trpcServer } from '@hono/trpc-server';

import { appRouter } from '@roomote/sdk/server';

import type { Variables } from '../../types';

export const trpc = new Hono<{ Variables: Variables }>();

trpc.use(
  '/*',
  trpcServer({
    router: appRouter,
    createContext: (_opts, c: Context<{ Variables: Variables }>) => ({
      auth: c.get('authContext'),
      req: c.req,
    }),
  }),
);
