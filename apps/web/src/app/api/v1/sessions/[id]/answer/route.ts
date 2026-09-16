import { z } from 'zod';

import {
  jsonOk,
  readJsonBody,
  resolveSessionIds,
  withApiV1Auth,
} from '@/lib/server/api-v1';
import { submitFastSessionUserInputCommand } from '@/trpc/commands/fast-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  requestId: z.string().min(1).max(200),
  answers: z.record(
    z.string().min(1),
    z.object({ answers: z.array(z.string().max(20_000)).max(50) }),
  ),
  resolution: z.enum(['submitted', 'cancelled']).optional(),
});

export const POST = withApiV1Auth<{ id: string }>(
  async ({ request, auth, params }) => {
    const { fastConversationId } = await resolveSessionIds(params.id);
    const input = await readJsonBody(request, bodySchema);
    return jsonOk(
      await submitFastSessionUserInputCommand(auth, {
        sessionId: fastConversationId,
        requestId: input.requestId,
        answers: input.answers,
        ...(input.resolution ? { resolution: input.resolution } : {}),
      }),
    );
  },
);
