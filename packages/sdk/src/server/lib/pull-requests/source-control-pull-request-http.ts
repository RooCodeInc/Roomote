import { z } from 'zod';
import {
  formatResponseBody,
  type FetchImpl,
} from './source-control-pull-request-shared';

export type SourceControlRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

/**
 * Shared JSON HTTP transport for the provider-neutral source-control PR
 * surface. Reads, writes, and create/update used to each carry a private
 * `requestJson` (and writes also private `performRequest`); keep one
 * implementation so auth headers, Accept, and failure formatting stay aligned.
 */
export async function performSourceControlRequest({
  fetchImpl,
  method = 'GET',
  url,
  tokenHeader,
  body,
}: {
  fetchImpl: FetchImpl;
  method?: SourceControlRequestMethod;
  url: string;
  tokenHeader: { name: string; value: string };
  body?: Record<string, unknown>;
}): Promise<Response> {
  return fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/json',
      [tokenHeader.name]: tokenHeader.value,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export async function buildSourceControlRequestFailureMessage(
  response: Response,
): Promise<string> {
  return `Source control API request failed: ${response.status} ${
    response.statusText
  }${await formatResponseBody(response)}`;
}

export async function requestSourceControlJson<T>({
  fetchImpl,
  method = 'GET',
  url,
  tokenHeader,
  body,
  schema,
  acceptedStatuses,
}: {
  fetchImpl: FetchImpl;
  method?: SourceControlRequestMethod;
  url: string;
  tokenHeader: { name: string; value: string };
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
  /**
   * Statuses treated as success. Defaults to 200/201 to match the historical
   * mutation and write helpers; read callers that must stay GET-strict pass
   * `acceptedStatuses: [200]`.
   */
  acceptedStatuses?: readonly number[];
}): Promise<T> {
  const response = await performSourceControlRequest({
    fetchImpl,
    method,
    url,
    tokenHeader,
    body,
  });

  const statuses = acceptedStatuses ?? [200, 201];

  if (!statuses.includes(response.status)) {
    throw new Error(await buildSourceControlRequestFailureMessage(response));
  }

  return schema.parse(await response.json());
}
