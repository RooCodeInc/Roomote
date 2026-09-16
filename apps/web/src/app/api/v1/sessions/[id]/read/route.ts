import {
  ApiV1Error,
  jsonOk,
  resolveSessionIds,
  withApiV1Auth,
} from '@/lib/server/api-v1';
import { markSessionReadCommand } from '@/trpc/commands/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiV1Auth<{ id: string }>(async ({ auth, params }) => {
  const { sessionId } = await resolveSessionIds(params.id);
  if (!sessionId) throw new ApiV1Error('Session not found', 404);
  await markSessionReadCommand(auth, { sessionId });
  return jsonOk({ success: true });
});
