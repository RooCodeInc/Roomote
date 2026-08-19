import { decrypt } from '@roomote/db/encryption';
import type { McpConnectionRipplingConfig } from '@roomote/types';

export const RIPPLING_API_BASE_URL = 'https://rest.ripplingapis.com/';
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

type RipplingErrorResponse = {
  detail?: string;
  message?: string;
};

export class RipplingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = 'RipplingApiError';
  }
}

export function resolveRipplingApiToken(
  config: McpConnectionRipplingConfig,
): string {
  const token = decrypt(config.encryptedApiToken).trim();
  if (!token) {
    throw new Error('Rippling connection is missing a stored API token');
  }
  return token;
}

export function resolveRipplingPageUrl(pathOrUrl: string): URL {
  const url = new URL(pathOrUrl, RIPPLING_API_BASE_URL);
  const base = new URL(RIPPLING_API_BASE_URL);
  if (url.protocol !== base.protocol || url.host !== base.host) {
    throw new Error('Rippling pagination returned an unexpected API origin');
  }
  return url;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - Date.now()) / 1000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ripplingApiRequestJson<T>(params: {
  config: McpConnectionRipplingConfig;
  pathOrUrl: string;
  query?: Record<string, string | number | undefined>;
  attempts?: number;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}): Promise<T> {
  const url = resolveRipplingPageUrl(params.pathOrUrl);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const attempts = Math.max(1, params.attempts ?? 3);
  const fetchImpl = params.fetchImpl ?? fetch;
  const wait = params.wait ?? sleep;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${resolveRipplingApiToken(params.config)}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt + 1 >= attempts) throw error;
      await wait(500 * 2 ** attempt);
      continue;
    }

    if (response.ok) return (await response.json()) as T;

    const payload = (await response
      .json()
      .catch(() => null)) as RipplingErrorResponse | null;
    const retryAfter = retryAfterSeconds(response);
    const error = new RipplingApiError(
      payload?.detail?.trim() ||
        payload?.message?.trim() ||
        `Rippling API request failed with status ${response.status}`,
      response.status,
      retryAfter,
    );

    if (
      !RETRYABLE_STATUS_CODES.has(response.status) ||
      attempt + 1 >= attempts
    ) {
      throw error;
    }

    await wait(
      Math.max(
        retryAfter === null ? 0 : retryAfter * 1000,
        response.status === 429 ? 10_000 : 500 * 2 ** attempt,
      ),
    );
  }

  throw new Error('Rippling API request exhausted retries');
}

export async function validateRipplingConnection(
  config: McpConnectionRipplingConfig,
): Promise<void> {
  await ripplingApiRequestJson({
    config,
    pathOrUrl: 'workers/',
    query: {
      limit: 1,
      expand: 'user,manager,manager.user,department,employment_type,teams',
    },
  });
}
