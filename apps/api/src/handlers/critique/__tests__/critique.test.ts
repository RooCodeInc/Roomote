import { Hono } from 'hono';
import { createCritiqueSubmissionCapability } from '@roomote/compute-providers';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { critique } from '..';

const { mockEnv, logHandlerErrorMock } = vi.hoisted(() => ({
  mockEnv: {
    CRITIQUE_BASE_URL: 'https://critique.example.test/',
    CRITIQUE_API_TOKEN: 'critique-secret-token',
    ARTIFACT_SIGNING_KEY: 'artifact-signing-key',
    ARTIFACT_SIGNING_KEY_PREVIOUS: undefined as string | undefined,
  },
  logHandlerErrorMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: mockEnv }));
vi.mock('../../utils', () => ({ logHandlerError: logHandlerErrorMock }));

const runAuth: RunTokenContext = {
  runId: 42,
  userId: 'user-1',
  principal: 'user',
  tokenType: 'run',
  version: 1,
};

function createApp(authContext: Variables['authContext'] = runAuth) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (authContext) c.set('authContext', authContext);
    await next();
  });
  app.route('/critique', critique);
  return app;
}

function request(body = 'multipart-body', includeCapability = true) {
  const runToken = 'run-token';
  return new Request('http://localhost/critique', {
    method: 'POST',
    headers: {
      'content-type': 'multipart/form-data; boundary=test-boundary',
      'content-length': String(Buffer.byteLength(body)),
      authorization: `Bearer ${runToken}`,
      ...(includeCapability
        ? {
            'x-roomote-critique-submission-capability':
              createCritiqueSubmissionCapability({
                runToken,
                expiresAtMs: Date.now() + 60_000,
                signingKey: mockEnv.ARTIFACT_SIGNING_KEY,
              }),
          }
        : {}),
    },
    body,
  });
}

describe('Critique proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.CRITIQUE_BASE_URL = 'https://critique.example.test/';
    mockEnv.CRITIQUE_API_TOKEN = 'critique-secret-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('forwards multipart once with bearer auth and preserves a partial response', async () => {
    const partial = {
      status: 'partial',
      findings: [{ id: 'f1', verdict: 'fail', confidence: 0.91 }],
      omittedFindingCount: 3,
      errors: [{ code: 'rule_timeout', message: 'One rule timed out' }],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(partial), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApp().request(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(partial);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://critique.example.test/v1/critiques',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: 'Bearer critique-secret-token',
      'content-type': 'multipart/form-data; boundary=test-boundary',
    });
    await expect((init.body as Blob).text()).resolves.toBe('multipart-body');
  });

  it.each([
    [422, 400, 'rejected the capture or input'],
    [502, 502, 'service is unavailable'],
    [503, 503, 'service is unavailable'],
  ])(
    'maps upstream %i accurately without retrying',
    async (upstreamStatus, expectedStatus, expectedMessage) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: `upstream detail ${mockEnv.CRITIQUE_API_TOKEN}`,
          }),
          { status: upstreamStatus },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const response = await createApp().request(request());
      const payload = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(expectedStatus);
      expect(payload.error).toContain(expectedMessage);
      expect(payload.upstreamStatus).toBe(upstreamStatus);
      expect(payload.detail).toContain('[REDACTED]');
      expect(JSON.stringify(payload)).not.toContain(mockEnv.CRITIQUE_API_TOKEN);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('times out once after at least 150 seconds and warns against retry', async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) => {
        expect(milliseconds).toBeGreaterThanOrEqual(150_000);
        const controller = new AbortController();
        queueMicrotask(() => controller.abort());
        return controller.signal;
      });
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApp().request(request());
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(504);
    expect(payload.error).toContain('160000ms');
    expect(payload.error).toContain('must not be retried automatically');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(160_000);
  });

  it('returns advisory unavailability without calling upstream when unconfigured', async () => {
    mockEnv.CRITIQUE_API_TOKEN = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApp().request(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Critique visual review is not configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects arbitrary direct task-token multipart submissions', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApp().request(
      request('arbitrary-task-data', false),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid Critique submission capability',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-run auth and oversized payloads before upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const memberResponse = await createApp({
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    }).request(request());
    expect(memberResponse.status).toBe(403);

    const oversizedResponse = await createApp().request(
      new Request('http://localhost/critique', {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=test',
          'content-length': String(32 * 1024 * 1024 + 1),
          authorization: 'Bearer run-token',
          'x-roomote-critique-submission-capability':
            createCritiqueSubmissionCapability({
              runToken: 'run-token',
              expiresAtMs: Date.now() + 60_000,
              signingKey: mockEnv.ARTIFACT_SIGNING_KEY,
            }),
        },
        body: 'small',
      }),
    );
    expect(oversizedResponse.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
