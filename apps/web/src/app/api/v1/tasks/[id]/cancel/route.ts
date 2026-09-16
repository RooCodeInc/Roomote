import { z } from 'zod';

import {
  ApiV1Error,
  jsonOk,
  readJsonBody,
  withApiV1Auth,
} from '@/lib/server/api-v1';
import { cancelTaskRunCommand } from '@/trpc/commands/task-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({ terminate: z.boolean().optional() })
  .optional()
  .default({});

export const POST = withApiV1Auth<{ id: string }>(
  async ({ request, auth, params }) => {
    const input =
      request.headers.get('content-length') === '0' ||
      !request.headers.get('content-type')?.includes('application/json')
        ? {}
        : await readJsonBody(request, bodySchema);
    const result = await cancelTaskRunCommand(auth, {
      taskId: params.id,
      ...(input.terminate !== undefined ? { terminate: input.terminate } : {}),
    });
    if (!result.success) throw new ApiV1Error(result.error, 409);
    return jsonOk({ success: true });
  },
);
