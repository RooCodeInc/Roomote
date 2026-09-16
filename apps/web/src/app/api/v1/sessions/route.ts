import { z } from 'zod';

import {
  dataUrlImageSchema,
  jsonOk,
  readJsonBody,
  readSearchParams,
  withApiV1Auth,
} from '@/lib/server/api-v1';
import { getSessions } from '@/lib/server/sessions';
import { sessionsListInputSchema } from '@/trpc/commands/sessions';
import { startFastSessionCommand } from '@/trpc/commands/fast-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const listQuerySchema = sessionsListInputSchema
  .pick({ scope: true, status: true, q: true, before: true })
  .extend({ limit: z.coerce.number().int().min(1).max(200).optional() });

export const GET = withApiV1Auth(async ({ request, auth }) => {
  const input = readSearchParams(request, listQuerySchema);
  return jsonOk(await getSessions(auth, input));
});

const createSchema = z.object({
  text: z.string().trim().min(1).max(50_000),
  model: z.string().min(1).max(200).nullish(),
  images: z.array(dataUrlImageSchema).max(10).optional(),
});

export const POST = withApiV1Auth(async ({ request, auth }) => {
  const input = await readJsonBody(request, createSchema);
  const result = await startFastSessionCommand(auth, {
    text: input.text,
    ...(input.model ? { model: input.model } : {}),
    ...(input.images ? { images: input.images } : {}),
  });
  return jsonOk(result, { status: 201 });
});
