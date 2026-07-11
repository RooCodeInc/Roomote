import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
      'https://api.newmote.dev/trpc/taskRuns.recordMessageEnvelope?batch=1',
      {
        method: 'POST',
        body: '{"0":{"json":{"runId":42}}}',
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
      'https://api.newmote.dev/trpc/taskRuns.recordMessageEnvelope?batch=1',
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

  it('gives the dequeue claim a longer default retry budget than other callbacks', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
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
    expect(fetchMock).toHaveBeenCalledTimes(6);
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
