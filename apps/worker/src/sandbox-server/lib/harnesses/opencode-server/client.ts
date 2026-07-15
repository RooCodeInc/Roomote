import type { HarnessLogger } from '../../../../logging';

import type {
  OpenCodeGlobalEvent,
  OpenCodePromptPart,
  OpenCodePromptRequest,
  OpenCodeSession,
  OpenCodeSessionMessage,
} from './types';

// Bound every unary OpenCode HTTP call so a wedged server cannot leave the
// worker sitting forever on a bare `fetch` with only the task-wide cancel
// signal. Session create is the first workspace touch (lazy instance bootstrap)
// and historically has wedged self-hosted workers with zero further logs —
// give it its own ceiling and override. Streaming events are unbounded.
export const DEFAULT_OPENCODE_HTTP_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENCODE_SESSION_CREATE_TIMEOUT_MS = 90_000;
const DEFAULT_OPENCODE_HEALTH_TIMEOUT_MS = 15_000;

interface OpenCodeServerClientOptions {
  baseUrl: string;
  workspacePath: string;
  logger: HarnessLogger;
  httpTimeoutMs?: number;
  sessionCreateTimeoutMs?: number;
  healthTimeoutMs?: number;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  expectedStatus?: number;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  label?: string;
}

function parsePositiveTimeoutMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export function resolveOpenCodeHttpTimeoutMs(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    override ??
    parsePositiveTimeoutMs(env.ROOMOTE_OPENCODE_HTTP_TIMEOUT_MS) ??
    DEFAULT_OPENCODE_HTTP_TIMEOUT_MS
  );
}

export function resolveOpenCodeSessionCreateTimeoutMs(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    override ??
    parsePositiveTimeoutMs(env.ROOMOTE_OPENCODE_SESSION_CREATE_TIMEOUT_MS) ??
    DEFAULT_OPENCODE_SESSION_CREATE_TIMEOUT_MS
  );
}

function resolveOpenCodeHealthTimeoutMs(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    override ??
    parsePositiveTimeoutMs(env.ROOMOTE_OPENCODE_HEALTH_TIMEOUT_MS) ??
    DEFAULT_OPENCODE_HEALTH_TIMEOUT_MS
  );
}

export function formatOpenCodeSessionCreateTimeoutText(
  timeoutMs: number,
): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));

  return `OpenCode session creation did not respond within ${seconds}s. The OpenCode server is up, but the first session request never finished — usually a hang while OpenCode bootstraps the workspace instance (config, plugins, storage, or MCP). Open the Logs sidebar and inspect harness.log for OpenCode lines (prefixed [opencode-server], including stuck \`creating instance\` / \`bootstrapping\` output), then cancel and retry.`;
}

function composeAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const defined = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );

  if (defined.length === 0) {
    return undefined;
  }

  if (defined.length === 1) {
    return defined[0];
  }

  return AbortSignal.any(defined);
}

function appendDirectorySearchParam(
  url: URL,
  workspacePath: string,
  query?: RequestOptions['query'],
): void {
  url.searchParams.set('directory', workspacePath);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }
}

function createTextPromptPart(text: string): OpenCodePromptPart {
  return { type: 'text', text };
}

function createImagePromptPart(image: string): OpenCodePromptPart | null {
  const trimmed = image.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,/iu.exec(trimmed);

    return {
      type: 'file',
      mime: match?.[1] ?? 'image/png',
      filename: 'image.png',
      url: trimmed,
    };
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed) && trimmed.length >= 16) {
    return {
      type: 'file',
      mime: 'image/png',
      filename: 'image.png',
      url: `data:image/png;base64,${trimmed}`,
    };
  }

  return {
    type: 'file',
    mime: 'image/png',
    filename: trimmed.split('/').pop() || 'image.png',
    url: trimmed,
  };
}

function parseServerSentEventData(chunk: string): unknown[] {
  return chunk
    .split('\n\n')
    .map((eventBlock) =>
      eventBlock
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n'),
    )
    .filter((data) => data.length > 0)
    .flatMap((data) => {
      try {
        return [JSON.parse(data)];
      } catch {
        return [];
      }
    });
}

export function createOpenCodePromptParts(options: {
  text?: string;
  images?: string[];
}): OpenCodePromptPart[] {
  const parts = (options.images ?? [])
    .map(createImagePromptPart)
    .filter((part): part is OpenCodePromptPart => part !== null);

  if ((options.text?.trim().length ?? 0) > 0 || parts.length === 0) {
    parts.push(createTextPromptPart(options.text ?? ''));
  }

  return parts;
}

export class OpenCodeServerClient {
  private readonly baseUrl: string;
  private readonly workspacePath: string;
  private readonly logger: HarnessLogger;
  private readonly httpTimeoutMs: number;
  private readonly sessionCreateTimeoutMs: number;
  private readonly healthTimeoutMs: number;

  constructor(options: OpenCodeServerClientOptions) {
    this.baseUrl = options.baseUrl.endsWith('/')
      ? options.baseUrl
      : `${options.baseUrl}/`;
    this.workspacePath = options.workspacePath;
    this.logger = options.logger;
    this.httpTimeoutMs = resolveOpenCodeHttpTimeoutMs(options.httpTimeoutMs);
    this.sessionCreateTimeoutMs = resolveOpenCodeSessionCreateTimeoutMs(
      options.sessionCreateTimeoutMs,
    );
    this.healthTimeoutMs = resolveOpenCodeHealthTimeoutMs(
      options.healthTimeoutMs,
    );
  }

  get sessionCreateTimeoutMsValue(): number {
    return this.sessionCreateTimeoutMs;
  }

  get workspaceDirectory(): string {
    return this.workspacePath;
  }

  async health(
    signal?: AbortSignal,
  ): Promise<{ healthy: true; version: string }> {
    return await this.request('/global/health', {
      signal,
      query: undefined,
      timeoutMs: this.healthTimeoutMs,
      label: 'health',
    });
  }

  async createSession(options?: {
    title?: string;
    signal?: AbortSignal;
  }): Promise<OpenCodeSession> {
    return await this.request('/session', {
      method: 'POST',
      body: options?.title ? { title: options.title } : {},
      signal: options?.signal,
      timeoutMs: this.sessionCreateTimeoutMs,
      label: 'createSession',
    });
  }

  async promptAsync(options: {
    sessionId: string;
    request: OpenCodePromptRequest;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.request(
      `/session/${encodeURIComponent(options.sessionId)}/prompt_async`,
      {
        method: 'POST',
        body: options.request,
        signal: options.signal,
        expectedStatus: 204,
        label: 'promptAsync',
      },
    );
  }

  async messages(options: {
    sessionId: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<OpenCodeSessionMessage[]> {
    return await this.request(
      `/session/${encodeURIComponent(options.sessionId)}/message`,
      {
        signal: options.signal,
        query: { limit: options.limit },
        label: 'messages',
      },
    );
  }

  async message(options: {
    sessionId: string;
    messageId: string;
    signal?: AbortSignal;
  }): Promise<OpenCodeSessionMessage> {
    return await this.request(
      `/session/${encodeURIComponent(options.sessionId)}/message/${encodeURIComponent(
        options.messageId,
      )}`,
      {
        signal: options.signal,
        label: 'message',
      },
    );
  }

  async children(options: {
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<OpenCodeSession[]> {
    return await this.request(
      `/session/${encodeURIComponent(options.sessionId)}/children`,
      {
        signal: options.signal,
        label: 'children',
      },
    );
  }

  async abort(options: {
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    return await this.request(
      `/session/${encodeURIComponent(options.sessionId)}/abort`,
      {
        method: 'POST',
        body: {},
        signal: options.signal,
        label: 'abort',
      },
    );
  }

  async streamEvents(options: {
    signal: AbortSignal;
    onEvent: (event: OpenCodeGlobalEvent) => void | Promise<void>;
  }): Promise<void> {
    const url = new URL('/global/event', this.baseUrl);
    const response = await fetch(url, {
      method: 'GET',
      signal: options.signal,
      headers: {
        Accept: 'text/event-stream',
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `OpenCode event stream failed status=${response.status} ${response.statusText}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lastBoundary = buffer.lastIndexOf('\n\n');

        if (lastBoundary < 0) {
          continue;
        }

        const complete = buffer.slice(0, lastBoundary + 2);
        buffer = buffer.slice(lastBoundary + 2);

        for (const event of parseServerSentEventData(complete)) {
          await options.onEvent(event as OpenCodeGlobalEvent);
        }
      }
    } catch (error) {
      if (options.signal.aborted) {
        return;
      }

      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const label = options.label ?? path;
    const timeoutMs = options.timeoutMs ?? this.httpTimeoutMs;
    const url = new URL(path.replace(/^\//u, ''), this.baseUrl);

    appendDirectorySearchParam(url, this.workspacePath, options.query);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = composeAbortSignals([options.signal, timeoutSignal]);
    const startedAt = Date.now();

    this.logger.info(
      `[opencode-server] HTTP request start method=${method} path=${path} label=${label} directory=${this.workspacePath} timeoutMs=${timeoutMs}`,
    );

    try {
      const response = await fetch(url, {
        method,
        signal,
        headers: {
          ...(options.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
      const expectedStatus = options.expectedStatus ?? 200;
      const elapsedMs = Date.now() - startedAt;

      if (response.status === expectedStatus) {
        if (expectedStatus === 204) {
          this.logger.info(
            `[opencode-server] HTTP request ok method=${method} path=${path} label=${label} status=${response.status} elapsedMs=${elapsedMs}`,
          );
          return undefined as T;
        }

        const body = (await response.json()) as T;
        this.logger.info(
          `[opencode-server] HTTP request ok method=${method} path=${path} label=${label} status=${response.status} elapsedMs=${elapsedMs}`,
        );
        return body;
      }

      const responseText = await response.text().catch(() => '');
      this.logger.warn(
        `[opencode-server] HTTP request failed method=${method} path=${path} label=${label} status=${response.status} elapsedMs=${elapsedMs} body=${responseText.slice(
          0,
          500,
        )}`,
      );
      throw new Error(
        `OpenCode request failed method=${method} path=${path} status=${response.status}`,
      );
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;

      if (timeoutSignal.aborted && !options.signal?.aborted) {
        const message =
          label === 'createSession'
            ? formatOpenCodeSessionCreateTimeoutText(timeoutMs)
            : `OpenCode ${label} request timed out after ${timeoutMs}ms method=${method} path=${path} directory=${this.workspacePath}`;
        this.logger.error(
          `[opencode-server] HTTP request timed out method=${method} path=${path} label=${label} timeoutMs=${timeoutMs} elapsedMs=${elapsedMs} directory=${this.workspacePath}`,
        );
        throw new Error(message);
      }

      if (!options.signal?.aborted) {
        this.logger.warn(
          `[opencode-server] HTTP request error method=${method} path=${path} label=${label} elapsedMs=${elapsedMs} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      throw error;
    }
  }
}
