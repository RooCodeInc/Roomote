import { z } from 'zod';

import { fastAgentCapabilityIdSchema } from '@roomote/types';

import {
  jsonOk,
  readJsonBody,
  resolveSessionIds,
  withApiV1Auth,
} from '@/lib/server/api-v1';
import { resolveFastSessionCapabilityOfferCommand } from '@/trpc/commands/fast-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  offerId: z.string().min(1).max(200),
  capability: fastAgentCapabilityIdSchema,
  resolution: z.enum(['completed', 'dismissed']),
  selectedIds: z.array(z.string().min(1).max(200)).max(50).optional(),
});

export const POST = withApiV1Auth<{ id: string }>(
  async ({ request, auth, params }) => {
    const { fastConversationId } = await resolveSessionIds(params.id);
    const input = await readJsonBody(request, bodySchema);
    return jsonOk(
      await resolveFastSessionCapabilityOfferCommand(auth, {
        sessionId: fastConversationId,
        offerId: input.offerId,
        capability: input.capability,
        resolution: input.resolution,
        ...(input.selectedIds ? { selectedIds: input.selectedIds } : {}),
      }),
    );
  },
);
