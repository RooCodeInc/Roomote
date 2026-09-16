import { z } from 'zod';

import {
  dataUrlImageSchema,
  jsonOk,
  readJsonBody,
  withApiV1Auth,
} from '@/lib/server/api-v1';
import { sendSandboxPromptCommand } from '@/trpc/commands/sandbox-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  images: z.array(dataUrlImageSchema).max(10).optional(),
  clientMessageId: z.string().min(1).max(128).optional(),
});

export const POST = withApiV1Auth<{ id: string }>(
  async ({ request, auth, params }) => {
    const input = await readJsonBody(request, bodySchema);
    await sendSandboxPromptCommand(auth, {
      taskId: params.id,
      prompt: input.prompt,
      source: 'ios',
      ...(input.images ? { images: input.images } : {}),
      ...(input.clientMessageId
        ? { clientMessageId: input.clientMessageId }
        : {}),
    });
    return jsonOk({ success: true });
  },
);
