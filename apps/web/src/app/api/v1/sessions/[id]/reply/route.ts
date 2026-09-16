import { z } from 'zod';

import {
  dataUrlImageSchema,
  jsonOk,
  readJsonBody,
  resolveSessionIds,
  withApiV1Auth,
} from '@/lib/server/api-v1';
import { replyToFastSessionCommand } from '@/trpc/commands/fast-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  text: z.string().trim().min(1).max(50_000),
  clientMessageId: z.string().min(1).max(128).optional(),
  images: z.array(dataUrlImageSchema).max(10).optional(),
  model: z.string().min(1).max(200).nullish(),
});

export const POST = withApiV1Auth<{ id: string }>(
  async ({ request, auth, params }) => {
    const { fastConversationId } = await resolveSessionIds(params.id);
    const input = await readJsonBody(request, bodySchema);
    return jsonOk(
      await replyToFastSessionCommand(auth, {
        sessionId: fastConversationId,
        text: input.text,
        ...(input.clientMessageId
          ? { clientMessageId: input.clientMessageId }
          : {}),
        ...(input.images ? { images: input.images } : {}),
        ...(input.model ? { model: input.model } : {}),
      }),
    );
  },
);
