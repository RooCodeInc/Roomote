import { z } from 'zod';
import { requestSourceControlJson as requestJson } from './source-control-pull-request-http';
import {
  buildApiUrl,
  type FetchImpl,
} from './source-control-pull-request-shared';

export const ADO_API_VERSION = '7.1';

export const adoCreatedCommentSchema = z
  .object({ id: z.number().int().optional() })
  .passthrough();

export const adoThreadSchema = z
  .object({
    id: z.number().int(),
    status: z.string().nullable().optional(),
    comments: z.array(adoCreatedCommentSchema).optional(),
  })
  .passthrough();

export async function createAdoCommentThread({
  fetchImpl,
  tokenHeader,
  organizationApiBaseUrl,
  threadsPath,
  content,
  threadContext,
}: {
  fetchImpl: FetchImpl;
  tokenHeader: { name: string; value: string };
  organizationApiBaseUrl: string;
  threadsPath: string;
  content: string;
  threadContext?: Record<string, unknown>;
}): Promise<z.infer<typeof adoThreadSchema>> {
  return requestJson({
    fetchImpl,
    method: 'POST',
    url: buildApiUrl(organizationApiBaseUrl, threadsPath, {
      'api-version': ADO_API_VERSION,
    }),
    tokenHeader,
    body: {
      comments: [{ content, commentType: 'text' }],
      status: 'active',
      ...(threadContext ? { threadContext } : {}),
    },
    schema: adoThreadSchema,
  });
}

export function getFirstAdoCommentId(
  thread: z.infer<typeof adoThreadSchema>,
): string | null {
  const id = thread.comments?.[0]?.id;
  return id != null ? String(id) : null;
}
