import {
  ApiV1Error,
  jsonOk,
  resolveSessionIds,
  withApiV1Auth,
} from '@/lib/server/api-v1';
import { getSessionByIdCommand } from '@/trpc/commands/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiV1Auth<{ id: string }>(async ({ auth, params }) => {
  const { sessionId } = await resolveSessionIds(params.id);
  if (!sessionId) throw new ApiV1Error('Session not found', 404);
  const session = await getSessionByIdCommand(auth, sessionId);
  if (!session) throw new ApiV1Error('Session not found', 404);
  return jsonOk(session);
});
