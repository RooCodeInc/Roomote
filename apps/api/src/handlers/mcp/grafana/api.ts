import type { McpConnectionGrafanaConfig } from '@roomote/types';

import {
  resolveGrafanaBaseUrl,
  resolveGrafanaServiceAccountToken,
} from './connection';

class GrafanaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GrafanaApiError';
  }
}

type QueryValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>
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
    for (const entry of value) {
      searchParams.append(key, String(entry));
    }
    return;
  }

  searchParams.append(key, String(value));
}

async function parseErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
      errors?: Array<{ message?: string }>;
    } | null;
    const message =
      payload?.message?.trim() ||
      payload?.error?.trim() ||
      payload?.errors
        ?.map((entry) => entry.message?.trim())
        .filter((entry): entry is string => Boolean(entry))
        .join('; ');

    if (message) {
      return message;
    }
  }

  const text = (await response.text().catch(() => '')).trim();
  if (text) {
    return text;
  }

  return `Grafana API request failed with status ${response.status}`;
}

async function grafanaApiRequest(params: {
  config: McpConnectionGrafanaConfig;
  path: string;
  query?: Record<string, QueryValue>;
}): Promise<Response> {
  const url = new URL(params.path, `${resolveGrafanaBaseUrl(params.config)}/`);

  for (const [key, value] of Object.entries(params.query ?? {})) {
    appendQueryValue(url.searchParams, key, value);
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${resolveGrafanaServiceAccountToken(params.config)}`,
    },
  });

  if (!response.ok) {
    throw new GrafanaApiError(
      await parseErrorMessage(response.clone()),
      response.status,
    );
  }

  return response;
}

export async function grafanaApiGetJson<T>(params: {
  config: McpConnectionGrafanaConfig;
  path: string;
  query?: Record<string, QueryValue>;
}): Promise<T> {
  const response = await grafanaApiRequest(params);
  return (await response.json()) as T;
}
