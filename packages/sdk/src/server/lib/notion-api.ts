import { decrypt } from '@roomote/db/encryption';
import type { McpConnectionNotionConfig } from '@roomote/types';

const NOTION_API_BASE_URL = 'https://api.notion.com/v1/';
export const NOTION_API_VERSION = '2026-03-11';

type NotionErrorResponse = {
  code?: string;
  message?: string;
};

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

export function resolveNotionAccessToken(
  config: McpConnectionNotionConfig,
): string {
  const token = decrypt(config.encryptedToken).trim();

  if (!token) {
    throw new Error(
      'Notion connection is missing a stored internal integration secret',
    );
  }

  return token;
}

export async function notionApiRequestJson<T>(params: {
  config: McpConnectionNotionConfig;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}): Promise<T> {
  const url = new URL(params.path, NOTION_API_BASE_URL);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: params.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${resolveNotionAccessToken(params.config)}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_API_VERSION,
    },
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
  });

  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as NotionErrorResponse | null;
    const detail = payload?.message?.trim();
    const code = payload?.code?.trim() || null;
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter =
      retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    throw new NotionApiError(
      detail ||
        `Notion API request failed with status ${response.status}${code ? ` (${code})` : ''}`,
      response.status,
      code,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
    );
  }

  return (await response.json()) as T;
}
