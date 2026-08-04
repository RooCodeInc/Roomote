import type { McpConnectionGranolaConfig } from '@roomote/types';

import { resolveGranolaApiKey } from './connection';

const GRANOLA_API_BASE_URL = 'https://public-api.granola.ai';

type QueryValue = string | number | null | undefined;

function findErrorMessage(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload.trim() || null;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;

  for (const key of ['message', 'error', 'detail']) {
    const message = findErrorMessage(record[key]);
    if (message) {
      return message;
    }
  }

  if (Array.isArray(record.errors)) {
    const messages = record.errors
      .map(findErrorMessage)
      .filter((message): message is string => Boolean(message));
    if (messages.length > 0) {
      return messages.join('; ');
    }
  }

  return null;
}

async function parseErrorMessage(response: Response): Promise<string> {
  const body = (await response.text().catch(() => '')).trim();

  if (body) {
    try {
      const message = findErrorMessage(JSON.parse(body));
      if (message) {
        return message;
      }
    } catch {
      return body;
    }
  }

  return `Granola API request failed with status ${response.status}`;
}

export async function granolaApiGetJson<T>(params: {
  config: McpConnectionGranolaConfig;
  path: string;
  query?: Record<string, QueryValue>;
}): Promise<T> {
  const url = new URL(params.path, `${GRANOLA_API_BASE_URL}/`);

  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${resolveGranolaApiKey(params.config)}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as T;
}
