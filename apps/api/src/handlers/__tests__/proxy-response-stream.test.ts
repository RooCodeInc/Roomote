import {
  createLoggedProxyResponseBody,
  createSseKeepaliveProxyBody,
} from '../proxy-response-stream';

function createFailingBodyStream(error: Error): ReadableStream<Uint8Array> {
  let emittedInitialChunk = false;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emittedInitialChunk) {
        emittedInitialChunk = true;
        controller.enqueue(
          new TextEncoder().encode('event: ping\ndata: ok\n\n'),
        );
        return;
      }

      controller.error(error);
    },
  });
}

describe('createLoggedProxyResponseBody', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['AbortError', 'TimeoutError'] as const)(
    'logs %s stream failures at debug level',
    async (errorName) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const stream = createLoggedProxyResponseBody({
        body: createFailingBodyStream(
          new DOMException('expected disconnect', errorName),
        ),
        logPrefix: '[Proxy]',
        getLogFields: () => ({
          method: 'GET',
          path: '/stream',
        }),
      });

      await expect(new Response(stream).text()).rejects.toThrow(
        'expected disconnect',
      );

      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy.mock.calls[0]?.[0]).toContain('[Proxy]');
      expect(debugSpy.mock.calls[0]?.[0]).toContain(`errorName="${errorName}"`);
      expect(debugSpy.mock.calls[0]?.[0]).toContain(
        'error="expected disconnect"',
      );
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it('keeps unexpected stream failures at error level', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const stream = createLoggedProxyResponseBody({
      body: createFailingBodyStream(
        new TypeError('terminated', {
          cause: Object.assign(new Error('Body Timeout Error'), {
            name: 'BodyTimeoutError',
            code: 'UND_ERR_BODY_TIMEOUT',
          }),
        }),
      ),
      logPrefix: '[Proxy]',
      getLogFields: () => ({
        method: 'GET',
        path: '/stream',
      }),
    });

    await expect(new Response(stream).text()).rejects.toThrow('terminated');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('[Proxy]');
    expect(errorSpy.mock.calls[0]?.[0]).toContain('errorName="TypeError"');
    expect(errorSpy.mock.calls[0]?.[0]).toContain('error="terminated"');
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      'causeName="BodyTimeoutError"',
    );
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      'causeCode="UND_ERR_BODY_TIMEOUT"',
    );
    expect(debugSpy).not.toHaveBeenCalled();
  });
});

function createControlledBodyStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  close: () => void;
  fail: (error: Error) => void;
  cancelled: () => unknown;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelReason: unknown = undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });
  const encoder = new TextEncoder();

  return {
    stream,
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
    cancelled: () => cancelReason,
  };
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { done, value } = await reader.read();
  return done ? '<done>' : new TextDecoder().decode(value);
}

describe('createSseKeepaliveProxyBody', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null without a body', () => {
    expect(createSseKeepaliveProxyBody({ body: null, intervalMs: 10 })).toBe(
      null,
    );
  });

  it('emits comment lines while the upstream is silent and forwards events in order', async () => {
    const upstream = createControlledBodyStream();
    const reader = createSseKeepaliveProxyBody({
      body: upstream.stream,
      intervalMs: 1_000,
    })!.getReader();

    upstream.push('event: a\ndata: 1\n\n');
    expect(await readChunk(reader)).toBe('event: a\ndata: 1\n\n');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await readChunk(reader)).toBe(': keepalive\n\n');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await readChunk(reader)).toBe(': keepalive\n\n');

    upstream.push('event: b\ndata: 2\n\n');
    expect(await readChunk(reader)).toBe('event: b\ndata: 2\n\n');

    upstream.close();
    expect(await readChunk(reader)).toBe('<done>');
  });

  it('does not emit a comment when upstream bytes arrive within the interval', async () => {
    const upstream = createControlledBodyStream();
    const reader = createSseKeepaliveProxyBody({
      body: upstream.stream,
      intervalMs: 1_000,
    })!.getReader();

    await vi.advanceTimersByTimeAsync(900);
    upstream.push('data: 1\n\n');
    expect(await readChunk(reader)).toBe('data: 1\n\n');

    await vi.advanceTimersByTimeAsync(900);
    upstream.push('data: 2\n\n');
    expect(await readChunk(reader)).toBe('data: 2\n\n');

    upstream.close();
    expect(await readChunk(reader)).toBe('<done>');
  });

  it('propagates upstream failures', async () => {
    const upstream = createControlledBodyStream();
    const reader = createSseKeepaliveProxyBody({
      body: upstream.stream,
      intervalMs: 1_000,
    })!.getReader();

    upstream.fail(new Error('upstream gone'));

    await expect(reader.read()).rejects.toThrow('upstream gone');
  });

  it('cancels the upstream when the client disconnects and stops emitting', async () => {
    const upstream = createControlledBodyStream();
    const stream = createSseKeepaliveProxyBody({
      body: upstream.stream,
      intervalMs: 1_000,
    })!;
    const reader = stream.getReader();

    await reader.cancel('client closed');

    expect(upstream.cancelled()).toBe('client closed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await readChunk(reader)).toBe('<done>');
  });
});
