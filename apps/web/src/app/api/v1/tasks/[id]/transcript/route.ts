import { z } from 'zod';

import { jsonOk, readSearchParams, withApiV1Auth } from '@/lib/server/api-v1';
import { getTaskMessageEnvelopesCommand } from '@/trpc/commands/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cursorSchema = z.object({
  createdAt: z.string(),
  ts: z.number(),
  id: z.string().uuid(),
});

const querySchema = z.object({
  /** JSON-encoded `nextCursor` from a previous page. */
  cursor: z
    .string()
    .transform((value, ctx) => {
      try {
        return cursorSchema.parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
        return z.NEVER;
      }
    })
    .optional(),
});

export const GET = withApiV1Auth<{ id: string }>(
  async ({ request, auth, params }) => {
    const query = readSearchParams(request, querySchema);
    return jsonOk(
      await getTaskMessageEnvelopesCommand(auth, {
        taskId: params.id,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      }),
    );
  },
);
