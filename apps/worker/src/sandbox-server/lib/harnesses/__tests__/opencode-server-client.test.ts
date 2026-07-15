import {
  DEFAULT_OPENCODE_HTTP_TIMEOUT_MS,
  DEFAULT_OPENCODE_SESSION_CREATE_TIMEOUT_MS,
  OpenCodeServerClient,
  formatOpenCodeSessionCreateTimeoutText,
  resolveOpenCodeHttpTimeoutMs,
  resolveOpenCodeSessionCreateTimeoutMs,
} from '../opencode-server/client';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  };
}

describe('OpenCodeServerClient timeouts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('resolves timeout overrides from env', () => {
    expect(
      resolveOpenCodeHttpTimeoutMs(undefined, {
        ROOMOTE_OPENCODE_HTTP_TIMEOUT_MS: '45000',
      }),
    ).toBe(45_000);
    expect(
      resolveOpenCodeSessionCreateTimeoutMs(undefined, {
        ROOMOTE_OPENCODE_SESSION_CREATE_TIMEOUT_MS: '120000',
      }),
    ).toBe(120_000);
    expect(resolveOpenCodeHttpTimeoutMs()).toBe(
      DEFAULT_OPENCODE_HTTP_TIMEOUT_MS,
    );
    expect(resolveOpenCodeSessionCreateTimeoutMs()).toBe(
      DEFAULT_OPENCODE_SESSION_CREATE_TIMEOUT_MS,
    );
  });

  it('points session-create timeout copy at the Logs sidebar harness.log', () => {
    const text = formatOpenCodeSessionCreateTimeoutText(90_000);
    expect(text).toContain('Logs sidebar');
    expect(text).toContain('harness.log');
    expect(text).toContain('[opencode-server]');
  });

  it('times out createSession when OpenCode never responds', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const fetchMock = vi.fn((_url: URL | string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenCodeServerClient({
      baseUrl: 'http://127.0.0.1:4096',
      workspacePath: '/sandbox/repos',
      logger: logger as never,
      sessionCreateTimeoutMs: 50,
    });

    const pending = client.createSession({ title: 'hello' });
    const assertion = expect(pending).rejects.toThrow(
      formatOpenCodeSessionCreateTimeoutText(50),
    );

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('/session');
    expect(calledUrl).toContain('directory=%2Fsandbox%2Frepos');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('HTTP request timed out'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('label=createSession'),
    );
  });

  it('logs start/completion for successful session create', async () => {
    const logger = createLogger();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ id: 'ses_new', title: 't' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const client = new OpenCodeServerClient({
      baseUrl: 'http://127.0.0.1:4096',
      workspacePath: '/sandbox/repos',
      logger: logger as never,
      sessionCreateTimeoutMs: 5_000,
    });

    await expect(client.createSession()).resolves.toEqual({
      id: 'ses_new',
      title: 't',
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('HTTP request start'),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('HTTP request ok'),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('label=createSession'),
    );
  });
});
