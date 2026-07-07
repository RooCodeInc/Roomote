import { createLoggedProxyResponseBody } from '../proxy-response-stream';

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
