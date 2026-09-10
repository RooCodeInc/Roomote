import { createHash, createHmac } from 'node:crypto';

import { BrokerRequestError, RoomoteBrokerClient } from './roomote-broker';

const brokerUrl = 'https://broker.roomote.dev';
const tenantId = '9d137fea-a018-4432-af24-83ce802b4ed2';
const brokerKey = 'rbk_derived-tenant-credential';
const baseImageRef = `ghcr.io/roocodeinc/roomote-worker@sha256:${'a'.repeat(64)}`;

type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  rawBody: string;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonResponse(events: unknown[]): Response {
  return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

function harness(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const request: RecordedRequest = {
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        rawBody: typeof init?.body === 'string' ? init.body : '',
        body:
          typeof init?.body === 'string' && init.body
            ? JSON.parse(init.body)
            : undefined,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(
            ([key, value]) => [key.toLowerCase(), value],
          ),
        ),
      };
      requests.push(request);
      return handler(request);
    },
  );

  const client = new RoomoteBrokerClient({
    brokerUrl,
    tenantId,
    brokerKey,
    baseImageRef,
    timeoutMs: 60_000,
    cpu: 2,
    memoryMiB: 8_192,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  return { client, requests, fetchImpl };
}

describe('RoomoteBrokerClient', () => {
  it('signs every request with the tenant HMAC scheme', async () => {
    const { client, requests } = harness(() => jsonResponse({ instances: [] }));

    await client.listInstances({});

    const request = requests[0]!;
    expect(request.headers['x-roomote-tenant']).toBe(tenantId);
    expect(request.headers['x-roomote-nonce']).toBeTruthy();

    const expected = createHmac('sha256', brokerKey)
      .update(
        [
          request.headers['x-roomote-timestamp'],
          request.headers['x-roomote-nonce'],
          'GET',
          '/v1/sandboxes',
          createHash('sha256').update('').digest('hex'),
        ].join('\n'),
      )
      .digest('hex');
    expect(request.headers['x-roomote-signature']).toBe(expected);
  });

  it('includes a broker URL path prefix in the signed path', async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        rawBody: '',
        body: undefined,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(
            ([key, value]) => [key.toLowerCase(), value],
          ),
        ),
      });
      return jsonResponse({ instances: [] });
    });

    const client = new RoomoteBrokerClient({
      brokerUrl: 'http://localhost:4100/compute-broker',
      tenantId,
      brokerKey,
      baseImageRef,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.listInstances({});

    const request = requests[0]!;
    expect(request.path).toBe('/compute-broker/v1/sandboxes');

    const expected = createHmac('sha256', brokerKey)
      .update(
        [
          request.headers['x-roomote-timestamp'],
          request.headers['x-roomote-nonce'],
          'GET',
          '/compute-broker/v1/sandboxes',
          createHash('sha256').update('').digest('hex'),
        ].join('\n'),
      )
      .digest('hex');
    expect(request.headers['x-roomote-signature']).toBe(expected);
  });

  it('creates instances with configured resources and an idempotency key', async () => {
    const { client, requests } = harness(() =>
      jsonResponse({
        instanceId: 'sb-1',
        domains: { '3000': 'https://sb-1-3000.modal.host' },
      }),
    );

    const created = await client.createInstance({
      ports: [3000],
      tags: { roomote_task_run: '42' },
    });

    expect(created).toEqual({
      instanceId: 'sb-1',
      status: 'running',
      domains: { '3000': 'https://sb-1-3000.modal.host' },
    });
    const request = requests[0]!;
    expect(request.headers['idempotency-key']).toBeTruthy();
    expect(request.body).toEqual({
      imageRef: baseImageRef,
      ports: [3000],
      tags: { roomote_task_run: '42' },
      timeoutMs: 60_000,
      cpu: 2,
      memoryMiB: 8_192,
    });
  });

  it('resumes from a snapshot without sending an image ref', async () => {
    const { client, requests } = harness(() =>
      jsonResponse({ instanceId: 'sb-2' }),
    );

    const resumed = await client.resumeFromSnapshot({
      sourceSnapshotId: 'im-9',
    });

    expect(resumed).toMatchObject({
      instanceId: 'sb-2',
      sourceSnapshotId: 'im-9',
    });
    expect(requests[0]!.body).toMatchObject({ snapshotId: 'im-9' });
    expect(requests[0]!.body).not.toHaveProperty('imageRef');
  });

  it('maps a 404 status lookup to stopped', async () => {
    const { client } = harness(() =>
      jsonResponse(
        { error: 'Sandbox not found.', code: 'sandbox_not_found' },
        404,
      ),
    );

    await expect(
      client.getInstanceStatus({ instanceId: 'sb-gone' }),
    ).resolves.toEqual({ status: 'stopped' });
  });

  it('throws a typed error carrying the broker error code', async () => {
    const { client } = harness(() =>
      jsonResponse(
        {
          error: 'The requested image is not allowed.',
          code: 'image_not_allowed',
        },
        400,
      ),
    );

    await expect(client.createInstance({})).rejects.toMatchObject({
      name: 'BrokerRequestError',
      status: 400,
      code: 'image_not_allowed',
    });
  });

  it('aggregates streamed exec output and reports the exit code', async () => {
    const { client } = harness(() =>
      ndjsonResponse([
        { type: 'started', execId: 'exec-1' },
        { type: 'stdout', data: 'hello ' },
        { type: 'heartbeat' },
        { type: 'stdout', data: 'world' },
        { type: 'stderr', data: 'warn' },
        { type: 'exit', exitCode: 3 },
      ]),
    );

    const outputs: { stream: string; data: string }[] = [];
    const result = await client.runCommand({
      instanceId: 'sb-1',
      cmd: 'echo',
      args: ['hello world'],
      onOutput: (event) => outputs.push(event),
    });

    expect(result).toEqual({
      commandId: 'exec-1',
      exitCode: 3,
      stdout: 'hello world',
      stderr: 'warn',
    });
    // Aggregated delivery, one call per non-empty stream (Modal parity).
    expect(outputs).toEqual([
      { stream: 'stdout', data: 'hello world' },
      { stream: 'stderr', data: 'warn' },
    ]);
  });

  it('reports a grace-period exit for detached commands', async () => {
    const { client } = harness(() =>
      ndjsonResponse([
        { type: 'started', execId: 'exec-1' },
        { type: 'stderr', data: 'boom' },
        { type: 'exit', exitCode: 1 },
      ]),
    );

    const result = await client.runCommand({
      instanceId: 'sb-1',
      cmd: 'worker',
      detached: true,
    });

    expect(result).toEqual({
      commandId: 'exec-1',
      exitCode: 1,
      stdout: undefined,
      stderr: 'boom',
    });
  });

  it('delivers stderr before rejecting a failed detached startup', async () => {
    const { client } = harness(() =>
      ndjsonResponse([
        { type: 'started', execId: 'exec-failed' },
        { type: 'stderr', data: 'worker import failed\n' },
        { type: 'error', message: 'exec stream failed' },
      ]),
    );
    const outputs: { stream: string; data: string }[] = [];

    await expect(
      client.runCommand({
        instanceId: 'sb-1',
        cmd: 'worker',
        detached: true,
        onOutput: (event) => outputs.push(event),
      }),
    ).rejects.toThrow('exec stream failed');
    expect(outputs).toEqual([
      { stream: 'stderr', data: 'worker import failed\n' },
    ]);
  });

  it('returns a running detached command and delivers output and onExit from the stream', async () => {
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });

    const { client } = harness(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: 'started', execId: 'exec-1' })}\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: 'stdout', data: 'worker booting\n' })}\n`,
            ),
          );
          await tail;
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: 'stdout', data: 'worker ready\n' })}\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: 'stderr', data: 'worker warning\n' })}\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: 'exit', exitCode: 7 })}\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    const exitCodes: number[] = [];
    const outputs: { stream: string; data: string }[] = [];
    const launchAbortController = new AbortController();
    let resolveExit!: () => void;
    const exitSeen = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const result = await client.runCommand({
      instanceId: 'sb-1',
      cmd: 'worker',
      detached: true,
      signal: launchAbortController.signal,
      onOutput: (event) => outputs.push(event),
      onExit: ({ exitCode }) => {
        exitCodes.push(exitCode);
        resolveExit();
      },
    });

    expect(result).toEqual({ commandId: 'exec-1', exitCode: null });
    launchAbortController.abort();
    releaseTail();
    await exitSeen;
    expect(exitCodes).toEqual([7]);
    expect(outputs).toEqual([
      { stream: 'stdout', data: 'worker booting\n' },
      { stream: 'stdout', data: 'worker ready\n' },
      { stream: 'stderr', data: 'worker warning\n' },
    ]);
  });

  it('recovers onExit via polling when started arrives late and the stream drops', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const { client } = harness((request) => {
        if (request.path.endsWith('/exec')) {
          const stream = new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
            },
          });
          return new Response(stream, { status: 200 });
        }

        // Exec-status poll must use the late-arriving exec id.
        if (request.path.endsWith('/exec/exec-late')) {
          return jsonResponse({ status: 'exited', exitCode: 5 });
        }

        return jsonResponse({ error: 'unexpected path' }, 500);
      });

      const exitCodes: number[] = [];
      const resultPromise = client.runCommand({
        instanceId: 'sb-1',
        cmd: 'worker',
        detached: true,
        onExit: ({ exitCode }) => {
          exitCodes.push(exitCode);
        },
      });

      // No events inside the grace period: the command reports as running.
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(resultPromise).resolves.toEqual({
        commandId: undefined,
        exitCode: null,
      });

      // started lands only now, then the stream drops before exit.
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({ type: 'started', execId: 'exec-late' })}\n`,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.error(new Error('connection reset'));
      await vi.advanceTimersByTimeAsync(31_000);

      expect(exitCodes).toEqual([5]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers broker errors that arrive after detached startup', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let releaseError!: () => void;
      const errorReady = new Promise<void>((resolve) => {
        releaseError = resolve;
      });
      const { client } = harness((request) => {
        if (request.path.endsWith('/exec')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `${JSON.stringify({ type: 'started', execId: 'exec-error' })}\n`,
                  ),
                );
                await errorReady;
                controller.enqueue(
                  encoder.encode(
                    `${JSON.stringify({ type: 'error', message: 'worker startup failed' })}\n`,
                  ),
                );
                controller.close();
              },
            }),
            { status: 200 },
          );
        }

        return jsonResponse({ status: 'exited', exitCode: 1 });
      });
      const outputs: { stream: string; data: string }[] = [];
      const exitCodes: number[] = [];
      const resultPromise = client.runCommand({
        instanceId: 'sb-1',
        cmd: 'worker',
        detached: true,
        onOutput: (event) => outputs.push(event),
        onExit: ({ exitCode }) => {
          exitCodes.push(exitCode);
        },
      });

      await vi.advanceTimersByTimeAsync(1_100);
      await expect(resultPromise).resolves.toEqual({
        commandId: 'exec-error',
        exitCode: null,
      });
      releaseError();
      await vi.advanceTimersByTimeAsync(0);
      expect(outputs).toContainEqual({
        stream: 'stderr',
        data: 'Broker exec error: worker startup failed\n',
      });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(exitCodes).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes files as base64 payloads', async () => {
    const { client, requests } = harness(() => jsonResponse({}));

    await client.writeFiles({
      instanceId: 'sb-1',
      files: [{ path: '/sandbox/install.sh', content: Buffer.from('echo hi') }],
    });

    expect(requests[0]!.method).toBe('PUT');
    expect(requests[0]!.body).toEqual({
      files: [
        {
          path: '/sandbox/install.sh',
          contentBase64: Buffer.from('echo hi').toString('base64'),
        },
      ],
    });
  });

  it('retries transient file upload failures', async () => {
    let attempts = 0;
    const { client, requests } = harness(() => {
      attempts += 1;
      return attempts < 3 ? jsonResponse({}, 502) : jsonResponse({});
    });

    vi.useFakeTimers();
    try {
      const pending = client.writeFiles({
        instanceId: 'sb-1',
        files: [
          { path: '/sandbox/install.sh', content: Buffer.from('echo hi') },
        ],
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBeUndefined();
      expect(requests).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry deterministic file upload failures', async () => {
    const { client, requests } = harness(() =>
      jsonResponse({ error: 'invalid file path' }, 400),
    );

    await expect(
      client.writeFiles({
        instanceId: 'sb-1',
        files: [
          { path: '/sandbox/install.sh', content: Buffer.from('echo hi') },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(1);
  });

  it('stops retrying file uploads when aborted during backoff', async () => {
    const { client, requests } = harness(() => jsonResponse({}, 502));
    const controller = new AbortController();

    vi.useFakeTimers();
    try {
      const pending = client.writeFiles({
        instanceId: 'sb-1',
        files: [
          { path: '/sandbox/install.sh', content: Buffer.from('echo hi') },
        ],
        signal: controller.signal,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'AbortError',
      });

      await vi.advanceTimersByTimeAsync(0);
      controller.abort();

      await assertion;
      expect(requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls snapshot operations to completion', async () => {
    let polls = 0;
    const { client } = harness((request) => {
      if (request.path.endsWith('/snapshot')) {
        return jsonResponse({ operationId: 'op-1' }, 202);
      }

      polls += 1;
      return jsonResponse(
        polls < 2
          ? { status: 'running' }
          : { status: 'succeeded', snapshotId: 'im-1' },
      );
    });

    vi.useFakeTimers();
    try {
      const pending = client.createSnapshot({ instanceId: 'sb-1' });
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(pending).resolves.toEqual({ snapshotId: 'im-1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the snapshot id before returning it', async () => {
    let polls = 0;
    const { client } = harness((request) => {
      if (request.path.endsWith('/snapshot')) {
        return jsonResponse({ operationId: 'op-1' }, 202);
      }

      polls += 1;
      return jsonResponse(
        polls < 2
          ? { status: 'running' }
          : { status: 'succeeded', snapshotId: 'im-1' },
      );
    });

    const reported: string[] = [];

    vi.useFakeTimers();
    try {
      const pending = client.createSnapshot({
        instanceId: 'sb-1',
        onSnapshotCreated: async (snapshotId) => {
          reported.push(snapshotId);
        },
      });
      await vi.advanceTimersByTimeAsync(11_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    // The broker has already torn the sandbox down by the time it reports
    // success, so a stall before the caller records the id would strand the
    // snapshot with no way to look it up again.
    expect(reported).toEqual(['im-1']);
  });

  it('surfaces snapshot failures with the broker error', async () => {
    const { client } = harness((request) =>
      request.path.endsWith('/snapshot')
        ? jsonResponse({ operationId: 'op-1' }, 202)
        : jsonResponse({ status: 'failed', error: 'snapshot blew up' }),
    );

    vi.useFakeTimers();
    try {
      const pending = client.createSnapshot({ instanceId: 'sb-1' });
      const assertion = expect(pending).rejects.toThrow('snapshot blew up');
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws an AbortError when the signal aborts a request', async () => {
    const { client } = harness(() => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.listInstances({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('exposes BrokerRequestError for callers that map status codes', () => {
    const error = new BrokerRequestError('nope', 404, 'sandbox_not_found');
    expect(error.status).toBe(404);
    expect(error.code).toBe('sandbox_not_found');
  });
});
