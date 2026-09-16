import { jsonOk, resolveSessionIds, withApiV1Auth } from '@/lib/server/api-v1';
import { getFastSessionMessagesCommand } from '@/trpc/commands/fast-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiV1Auth<{ id: string }>(async ({ auth, params }) => {
  const { fastConversationId } = await resolveSessionIds(params.id);
  return jsonOk(await getFastSessionMessagesCommand(auth, fastConversationId));
});
