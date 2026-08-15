import type { McpConnectionNotionConfig } from '@roomote/types';

import { resolveNotionAccessToken } from './connection';

const NOTION_API_BASE_URL = 'https://api.notion.com/v1/';
const NOTION_API_VERSION = '2026-03-11';

type NotionErrorResponse = {
  code?: string;
  message?: string;
};

export async function notionApiRequestJson<T>(params: {
  config: McpConnectionNotionConfig;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH';
  query?: Record<string, string | number | undefined>;
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
    const code = payload?.code?.trim();
    throw new Error(
      detail ||
        `Notion API request failed with status ${response.status}${code ? ` (${code})` : ''}`,
    );
  }

  return (await response.json()) as T;
}
