import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { createContext } from '@/trpc/init';
import { appRouter as router } from '@/trpc/routers/_app';

export const runtime = 'nodejs';

const handler = (req: Request) =>
  fetchRequestHandler({ endpoint: '/api/trpc', req, router, createContext });

export { handler as GET, handler as POST };
