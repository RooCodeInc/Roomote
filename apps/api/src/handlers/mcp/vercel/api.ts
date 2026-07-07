import type { McpConnectionVercelConfig } from '@roomote/types';

import {
  resolveVercelAccessToken,
  resolveVercelTeamIdOrSlug,
} from './connection';

const VERCEL_API_BASE_URL = 'https://api.vercel.com';

class VercelApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'VercelApiError';
  }
}

type QueryValue =
  | string
  | number
  | boolean
  | Array<string | number>
  | null
  | undefined;

function appendQueryValue(
  searchParams: URLSearchParams,
  key: string,
  value: QueryValue,
) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }

    searchParams.set(key, value.join(','));
    return;
  }

  searchParams.set(key, String(value));
}

function buildVercelTeamQuery(
  config: Pick<McpConnectionVercelConfig, 'defaultTeamIdOrSlug'>,
  requestedTeamIdOrSlug?: string,
): Record<string, string> {
  const teamIdOrSlug = resolveVercelTeamIdOrSlug(config, requestedTeamIdOrSlug);

  if (!teamIdOrSlug) {
    return {};
  }

  return teamIdOrSlug.startsWith('team_')
    ? { teamId: teamIdOrSlug }
    : { slug: teamIdOrSlug };
}

async function parseErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as {
      error?: {
        message?: string;
        code?: string;
      };
    } | null;
    const message = payload?.error?.message?.trim();
    if (message) {
      return message;
    }
  }

  const text = (await response.text().catch(() => '')).trim();
  if (text) {
    return text;
  }

  return `Vercel API request failed with status ${response.status}`;
}

async function vercelApiRequest(params: {
  config: McpConnectionVercelConfig;
  path: string;
  method?: 'GET' | 'POST';
  query?: Record<string, QueryValue>;
  body?: unknown;
  accept?: string;
}): Promise<Response> {
  const url = new URL(params.path, `${VERCEL_API_BASE_URL}/`);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    appendQueryValue(url.searchParams, key, value);
  }

  const headers = new Headers({
    Authorization: `Bearer ${resolveVercelAccessToken(params.config)}`,
    Accept: params.accept ?? 'application/json',
  });

  let body: string | undefined;
  if (params.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(params.body);
  }

  const response = await fetch(url, {
    method: params.method ?? 'GET',
    headers,
    body,
  });

  if (!response.ok) {
    throw new VercelApiError(
      await parseErrorMessage(response.clone()),
      response.status,
    );
  }

  return response;
}

export async function vercelApiGetJson<T>(params: {
  config: McpConnectionVercelConfig;
  path: string;
  query?: Record<string, QueryValue>;
}): Promise<T> {
  const response = await vercelApiRequest(params);
  return (await response.json()) as T;
}

export async function vercelApiPostJson<T>(params: {
  config: McpConnectionVercelConfig;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}): Promise<T> {
  const response = await vercelApiRequest({
    ...params,
    method: 'POST',
  });
  return (await response.json()) as T;
}

export async function vercelApiGetStreamJson<T>(params: {
  config: McpConnectionVercelConfig;
  path: string;
  query?: Record<string, QueryValue>;
}): Promise<T[]> {
  const response = await vercelApiRequest({
    ...params,
    accept: 'application/json, application/stream+json',
  });

  const text = await response.text();
  const trimmed = text.trim();

  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T];
  } catch {
    return trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }
}

export function withResolvedTeamQuery(
  config: Pick<McpConnectionVercelConfig, 'defaultTeamIdOrSlug'>,
  requestedTeamIdOrSlug: string | undefined,
  extraQuery?: Record<string, QueryValue>,
): Record<string, QueryValue> {
  return {
    ...buildVercelTeamQuery(config, requestedTeamIdOrSlug),
    ...(extraQuery ?? {}),
  };
}
