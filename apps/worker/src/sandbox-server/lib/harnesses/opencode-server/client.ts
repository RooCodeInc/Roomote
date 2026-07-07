import type { HarnessLogger } from '../../../../logging';

import type {
  OpenCodeGlobalEvent,
  OpenCodePromptPart,
  OpenCodePromptRequest,
  OpenCodeSession,
  OpenCodeSessionMessage,
} from './types';

interface OpenCodeServerClientOptions {
  baseUrl: string;
  workspacePath: string;
  logger: HarnessLogger;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  expectedStatus?: number;
  query?: Record<string, string | number | boolean | undefined>;
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

  constructor(options: OpenCodeServerClientOptions) {
    this.baseUrl = options.baseUrl.endsWith('/')
      ? options.baseUrl
      : `${options.baseUrl}/`;
    this.workspacePath = options.workspacePath;
    this.logger = options.logger;
  }

  async health(
    signal?: AbortSignal,
  ): Promise<{ healthy: true; version: string }> {
    return await this.request('/global/health', {
      signal,
      query: undefined,
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
    const url = new URL(path.replace(/^\//u, ''), this.baseUrl);

    appendDirectorySearchParam(url, this.workspacePath, options.query);

    const response = await fetch(url, {
      method: options.method ?? 'GET',
      signal: options.signal,
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

    if (response.status === expectedStatus) {
      if (expectedStatus === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }

    const responseText = await response.text().catch(() => '');
    this.logger.warn(
      `[opencode-server] HTTP request failed method=${options.method ?? 'GET'} path=${path} status=${response.status} body=${responseText.slice(
        0,
        500,
      )}`,
    );
    throw new Error(
      `OpenCode request failed method=${options.method ?? 'GET'} path=${path} status=${response.status}`,
    );
  }
}
