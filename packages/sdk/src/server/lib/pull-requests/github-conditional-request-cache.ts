const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

type GitHubResponseHeaders = Record<string, string | number | undefined>;

export type GitHubRestResponse<T> = {
  data: T;
  headers: GitHubResponseHeaders;
  status: number;
  url?: string;
};

type CacheEntry = {
  etag: string;
  response: GitHubRestResponse<unknown>;
  storedAt: number;
};

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const status = Number(error.status);
  return Number.isFinite(status) ? status : null;
}

function getHeader(
  headers: GitHubResponseHeaders | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

export class GitHubConditionalRequestCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  async request<T>(
    key: string,
    request: (
      headers: Record<string, string>,
    ) => Promise<GitHubRestResponse<T>>,
  ): Promise<GitHubRestResponse<T>> {
    const now = Date.now();
    const existing = this.entries.get(key);
    const cached =
      existing && now - existing.storedAt <= this.ttlMs ? existing : null;

    if (existing && !cached) this.entries.delete(key);

    try {
      const response = await request(
        cached ? { 'if-none-match': cached.etag } : {},
      );
      const etag = getHeader(response.headers, 'etag');

      if (etag) {
        this.entries.delete(key);
        this.entries.set(key, {
          etag,
          response: response as GitHubRestResponse<unknown>,
          storedAt: now,
        });
        this.trim();
      } else {
        this.entries.delete(key);
      }

      return response;
    } catch (error) {
      if (getErrorStatus(error) === 304 && cached) {
        this.entries.delete(key);
        this.entries.set(key, { ...cached, storedAt: now });
        return cached.response as GitHubRestResponse<T>;
      }
      throw error;
    }
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') return;
      this.entries.delete(oldestKey);
    }
  }
}

export const prReviewGitHubConditionalRequestCache =
  new GitHubConditionalRequestCache();
