import { z } from 'zod';

import { jsonOk, readJsonBody, withApiV1Auth } from '@/lib/server/api-v1';
import { answerSandboxUserInputRequestCommand } from '@/trpc/commands/sandbox-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  requestId: z.string().min(1).max(200),
  answers: z.record(
    z.string().min(1),
    z.object({ answers: z.array(z.string().max(20_000)).max(50) }),
  ),
});

export const POST = withApiV1Auth<{ id: string }>(
  async ({ request, auth, params }) => {
    const input = await readJsonBody(request, bodySchema);
    await answerSandboxUserInputRequestCommand(auth, {
      taskId: params.id,
      requestId: input.requestId,
      answers: input.answers,
    });
    return jsonOk({ success: true });
  },
);
