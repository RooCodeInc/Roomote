import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PUBLIC_URL_FETCH_TOOL } from '@roomote/types';
import { SafeFetchViolationError } from '@roomote/sdk/server/safe-fetch';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../middleware';
import { publicUrlFetchRoute } from '../public-url-fetch-route';
import {
  executePublicUrlFetch,
  registerRoomotePublicUrlFetchTool,
} from '../roomote-public-url-fetch';

const mocks = vi.hoisted(() => ({
  fetchPublicUrl: vi.fn(),
}));

vi.mock('@roomote/sdk/server/safe-fetch', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@roomote/sdk/server/safe-fetch')>();
  return { ...original, fetchPublicUrl: mocks.fetchPublicUrl };
});

describe('Roomote public URL fetch', () => {
  beforeEach(() => {
    mocks.fetchPublicUrl.mockReset();
    mocks.fetchPublicUrl.mockResolvedValue({
      url: 'https://example.com/',
      status: 200,
      contentType: 'text/plain',
      text: 'hello',
    });
  });

  it('registers the narrow shared MCP schema and forwards cancellation', async () => {
    const registerTool = vi.fn();
    registerRoomotePublicUrlFetchTool({ registerTool } as never);

    expect(registerTool).toHaveBeenCalledOnce();
    const [name, config, handler] = registerTool.mock.calls[0]!;
    expect(name).toBe(PUBLIC_URL_FETCH_TOOL.name);
    expect(config).toMatchObject({
      title: PUBLIC_URL_FETCH_TOOL.title,
      description: PUBLIC_URL_FETCH_TOOL.description,
      annotations: PUBLIC_URL_FETCH_TOOL.annotations,
    });
    expect(Object.keys(config.inputSchema)).toEqual(['url']);

    const controller = new AbortController();
    await handler(
      { url: 'https://example.com/' },
      { signal: controller.signal },
    );
    expect(mocks.fetchPublicUrl).toHaveBeenCalledWith('https://example.com/', {
      signal: controller.signal,
    });
  });

  it('requires existing MCP authentication on the coding-task proxy route', async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', mcpAuthMiddleware);
    app.route('/', publicUrlFetchRoute);

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });

    expect(response.status).toBe(401);
    expect(mocks.fetchPublicUrl).not.toHaveBeenCalled();
  });

  it('does not expose rejected network addresses in tool errors', async () => {
    mocks.fetchPublicUrl.mockRejectedValueOnce(
      new SafeFetchViolationError("Address '10.0.0.1' is not allowed"),
    );

    try {
      await executePublicUrlFetch({ url: 'https://internal.example/' });
      expect.unreachable('expected the fetch to be rejected');
    } catch (error) {
      expect(error).toMatchObject({
        message: 'URL was refused by Roomote public-destination policy.',
      });
      expect((error as Error).message).not.toContain('10.0.0.1');
    }
  });

  it('allows an authenticated task proxy request through the shared implementation', async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('authContext', {
        tokenType: 'run',
        runId: 'run-1',
        taskId: 'task-1',
        userId: null,
      } as never);
      await next();
    });
    app.use('*', mcpAuthMiddleware);
    app.route('/', publicUrlFetchRoute);

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: 'hello' });
  });
});
