import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer, type ServerResponse } from 'node:http';

import { buildWorkerHeaders, createWorkerFetchWithRetry } from './index';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve('tsx');
const clientEntryPath = fileURLToPath(new URL('./index.ts', import.meta.url));

describe('buildWorkerHeaders', () => {
  it('includes only authorization when no bypass env is set', () => {
    expect(
      buildWorkerHeaders({
        AUTH_TOKEN: 'run-token',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      Authorization: 'Bearer run-token',
    });
  });

  it('adds the default bypass header when a bypass value is present', () => {
    expect(
      buildWorkerHeaders({
        AUTH_TOKEN: 'run-token',
        ROOMOTE_AUTH_BYPASS_VALUE: 'bypass-token',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      Authorization: 'Bearer run-token',
      'x-bypass-roomote-auth': 'bypass-token',
    });
  });

  it('uses a custom bypass header name when configured', () => {
    expect(
      buildWorkerHeaders({
        AUTH_TOKEN: 'run-token',
        ROOMOTE_AUTH_BYPASS_VALUE: 'bypass-token',
        ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-custom-bypass',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      Authorization: 'Bearer run-token',
      'x-custom-bypass': 'bypass-token',
    });
  });

  it('imports the client-safe SDK entrypoint without the full app environment', async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          '--import',
          tsxLoaderPath,
          '--eval',
          `await import(${JSON.stringify(clientEntryPath)});`,
        ],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: {
            HOME: process.env.HOME ?? '',
            NODE_ENV: 'development',
          },
        },
      ),
    ).resolves.toMatchObject({
      stderr: '',
    });
  });
});

describe('createWorkerFetchWithRetry', () => {
  async function withStreamingFailures(
    failures: number,
    check: (
      url: string,
      active: Set<ServerResponse>,
      requests: () => number,
    ) => Promise<void>,
  ) {
    const active = new Set<ServerResponse>();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests <= failures) {
        active.add(response);
        response.on('close', () => active.delete(response));
        response.writeHead(503, { 'content-type': 'text/html' });
        response.write('Temporary upstream failure');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"restored":true}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing test listener');
      await check(
        `http://127.0.0.1:${address.port}/trpc/`,
        active,
        () => requests,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  it('closes discarded HTTP error streams while restoring the actual query response', async () => {
    await withStreamingFailures(2, async (url, active, requests) => {
      const workerFetch = createWorkerFetchWithRetry(fetch, {
        maxAttempts: 3,
        baseDelayMs: 1,
      });
      const response = await workerFetch(`${url}taskRuns.findRuntimeStateById`);
      expect(await response.json()).toEqual({ restored: true });
      expect(requests()).toBe(3);
      await vi.waitFor(() => expect(active.size).toBe(0));
    });
  });

  it.each(['GET', 'POST'])(
    'closes a rejected non-JSON HTTP response without replaying %s',
    async (method) => {
      await withStreamingFailures(Infinity, async (url, active, requests) => {
        const workerFetch = createWorkerFetchWithRetry(fetch, {
          maxAttempts: method === 'GET' ? 1 : 3,
        });
        await expect(
          workerFetch(`${url}taskRuns.done`, { method }),
        ).rejects.toThrow('non-JSON content-type');
        expect(requests()).toBe(1);
        await vi.waitFor(() => expect(active.size).toBe(0));
      });
    },
  );

  it('retains the final JSON error body for the caller after exhausting retries', async () => {
    const workerFetch = createWorkerFetchWithRetry(
      vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response('{"error":"unavailable"}', {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      { maxAttempts: 2, baseDelayMs: 0 },
    );
    const response = await workerFetch('https://api.example.test/trpc');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });

  it('does not turn a failed body cleanup into an additional request', async () => {
    const erroredBody = new ReadableStream({
      start(controller) {
        controller.error(new Error('body stream failed'));
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(erroredBody, { status: 503 }))
      .mockResolvedValueOnce(
        new Response('[]', { headers: { 'content-type': 'application/json' } }),
      );
    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });
    expect(
      await (await workerFetch('https://api.example.test/trpc')).json(),
    ).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries query fetch failures and returns the later success', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 2,
      baseDelayMs: 0,
    });

    const response = await workerFetch('https://api.roomote.dev/trpc', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the default retry budget for worker queries', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      baseDelayMs: 0,
    });

    const response = await workerFetch('https://api.roomote.dev/trpc', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries retryable query response statuses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 2,
      baseDelayMs: 0,
    });

    const response = await workerFetch('https://api.roomote.dev/trpc', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries non-JSON query responses and returns the later success', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('<!DOCTYPE html><html><body>Wrong host</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    const response = await workerFetch(
      'https://task-web.preview.roomote.run/trpc',
      {
        method: 'GET',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries retryable-status query responses when the callback body is non-JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          '<!DOCTYPE html><html><body>Temporary failure</body></html>',
          {
            status: 503,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    const response = await workerFetch(
      'https://task-api.preview.roomote.run/trpc',
      {
        method: 'GET',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the callback diagnostic after non-JSON query failures exhaust the retry budget', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        '<!DOCTYPE html><html><body>Temporary failure</body></html>',
        {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
    );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    await expect(
      workerFetch('https://task-api.preview.roomote.run/trpc', {
        method: 'GET',
      }),
    ).rejects.toThrow(/returned non-JSON content-type/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-query requests', async () => {
    const fetchError = new TypeError('fetch failed');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(fetchError);

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    await expect(
      workerFetch('https://api.roomote.dev/trpc', {
        method: 'POST',
      }),
    ).rejects.toBe(fetchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries recordMessageEnvelope callback persistence writes on transport failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 2,
      baseDelayMs: 0,
    });

    const response = await workerFetch(
      'https://api.octomote.dev/trpc/taskRuns.recordMessageEnvelope?batch=1',
      {
        method: 'POST',
        body: '{"0":{"json":{"runId":42}}}',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries the Slack task card render on transport failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 2,
      baseDelayMs: 0,
    });

    const response = await workerFetch(
      'https://api.octomote.dev/trpc/taskRuns.renderSlackLiveTaskCard?batch=1',
      {
        method: 'POST',
        body: '{"0":{"json":{"runId":42,"status":"complete"}}}',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries retryable non-JSON callback persistence responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          '<!DOCTYPE html><html><body>Temporary failure</body></html>',
          {
            status: 502,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 2,
      baseDelayMs: 0,
    });

    const response = await workerFetch(
      'https://api.octomote.dev/trpc/taskRuns.recordMessageEnvelope?batch=1',
      {
        method: 'POST',
        body: '{"0":{"json":{"runId":42}}}',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries the dequeue claim when the public edge answers without a JSON content-type', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      baseDelayMs: 0,
    });

    const response = await workerFetch(
      'https://web-example.ngrok.dev/_roomote-api/trpc/taskRuns.dequeue?batch=1',
      {
        method: 'POST',
        body: '{"0":{"json":{"runId":68}}}',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds the dequeue claim retry budget so the controller can replace a broken sandbox', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      baseDelayMs: 0,
    });

    const response = await workerFetch(
      'https://api.roomote.dev/trpc/taskRuns.dequeue?batch=1',
      {
        method: 'POST',
        body: '{"0":{"json":{"runId":68}}}',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries the resume claim on transport failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      baseDelayMs: 0,
    });

    const response = await workerFetch(
      'https://api.roomote.dev/trpc/taskRuns.resume?batch=1',
      {
        method: 'POST',
        body: '{"0":{"json":{"runId":68}}}',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets explicit wrapper options pin the dequeue retry budget', async () => {
    const fetchError = new TypeError('fetch failed');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(fetchError);

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 2,
      baseDelayMs: 0,
    });

    await expect(
      workerFetch('https://api.roomote.dev/trpc/taskRuns.dequeue?batch=1', {
        method: 'POST',
        body: '{"0":{"json":{"runId":68}}}',
      }),
    ).rejects.toBe(fetchError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-idempotent worker mutations', async () => {
    const fetchError = new TypeError('fetch failed');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(fetchError);

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    await expect(
      workerFetch('https://api.roomote.dev/trpc/taskRuns.done?batch=1', {
        method: 'POST',
        body: '{"0":{"json":{"id":42,"status":"completed"}}}',
      }),
    ).rejects.toBe(fetchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry abort errors', async () => {
    const abortError = new DOMException(
      'The operation was aborted',
      'AbortError',
    );
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(abortError);

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    await expect(
      workerFetch('https://api.roomote.dev/trpc', {
        method: 'GET',
      }),
    ).rejects.toBe(abortError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable query responses', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('{"error":{"json":{"message":"Bad request"}}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    const response = await workerFetch('https://api.roomote.dev/trpc', {
      method: 'GET',
    });

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast with a callback diagnostic when TRPC returns HTML', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<!DOCTYPE html><html><body>Wrong host</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const workerFetch = createWorkerFetchWithRetry(fetchMock, {
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    await expect(
      workerFetch('https://task-web.preview.roomote.run/trpc', {
        method: 'POST',
      }),
    ).rejects.toThrow(/returned non-JSON content-type/);
  });
});
