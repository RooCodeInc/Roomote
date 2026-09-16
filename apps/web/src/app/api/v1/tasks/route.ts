import { z } from 'zod';

import { jsonOk, readSearchParams, withApiV1Auth } from '@/lib/server/api-v1';
import { getTasksCommand } from '@/trpc/commands/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  /** `all` lists every task the caller can read; default is the caller's own. */
  user: z.enum(['me', 'all']).optional(),
});

export const GET = withApiV1Auth(async ({ request, auth }) => {
  const query = readSearchParams(request, querySchema);
  const cursor =
    query.cursor && /^\d+$/.test(query.cursor)
      ? Number(query.cursor)
      : query.cursor;
  return jsonOk(
    await getTasksCommand(auth, {
      ...(query.limit ? { limit: query.limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(query.user === 'all'
        ? { filters: [{ type: 'userId', value: 'all', label: 'All users' }] }
        : {}),
    }),
  );
});
