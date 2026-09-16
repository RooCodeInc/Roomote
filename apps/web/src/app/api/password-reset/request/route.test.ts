const {
  afterCallbacks,
  isSelfServicePasswordResetAllowedMock,
  isSelfServicePasswordResetAvailableMock,
  loggerInfoMock,
  loggerWarnMock,
  requestSelfServicePasswordResetMock,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  isSelfServicePasswordResetAllowedMock: vi.fn(),
  isSelfServicePasswordResetAvailableMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  requestSelfServicePasswordResetMock: vi.fn(),
}));

vi.mock('@/lib/server/self-service-password-reset', () => ({
  isSelfServicePasswordResetAllowed: isSelfServicePasswordResetAllowedMock,
  isSelfServicePasswordResetAvailable: isSelfServicePasswordResetAvailableMock,
}));
vi.mock('@/lib/server/user-management', () => ({
  requestSelfServicePasswordReset: requestSelfServicePasswordResetMock,
}));
vi.mock('@/lib/server/logger', () => ({
  logger: { info: loggerInfoMock, warn: loggerWarnMock },
}));
vi.mock('@/lib/server/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/env')>()),
  Env: { R_TRUSTED_PROXY_CLIENT_IP_HEADER: 'x-real-ip' },
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (callback: () => unknown) => afterCallbacks.push(callback),
}));

import { POST } from './route';

function createRequest(body: unknown, forwardedFor = '203.0.113.10, 10.0.0.1') {
  return new Request('http://localhost/api/password-reset/request', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': forwardedFor,
      'x-real-ip': '192.0.2.20',
    },
    body: JSON.stringify(body),
  });
}

describe('password reset request route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    isSelfServicePasswordResetAvailableMock.mockResolvedValue(true);
    isSelfServicePasswordResetAllowedMock.mockResolvedValue(true);
    requestSelfServicePasswordResetMock.mockResolvedValue('sent');
  });

  it('requests a reset while returning only a generic response', async () => {
    const response = await POST(
      createRequest({ email: 'ada@example.com' }) as never,
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(response.json()).resolves.toEqual({
      message:
        'If an active email/password account exists for that address, a reset link will arrive shortly.',
    });
    expect(isSelfServicePasswordResetAllowedMock).toHaveBeenCalledWith({
      email: 'ada@example.com',
      clientAddress: '192.0.2.20',
    });
    expect(requestSelfServicePasswordResetMock).not.toHaveBeenCalled();

    await afterCallbacks[0]?.();

    expect(requestSelfServicePasswordResetMock).toHaveBeenCalledWith(
      'ada@example.com',
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'password_reset_request',
        outcome: 'sent',
        requestId: expect.any(String),
      }),
      'Password reset request completed',
    );
  });

  it('ignores attacker-controlled forwarded addresses behind a trusted proxy', async () => {
    await POST(
      createRequest({ email: 'ada@example.com' }, '198.51.100.1') as never,
    );
    await POST(
      createRequest({ email: 'ada@example.com' }, '198.51.100.2') as never,
    );

    expect(isSelfServicePasswordResetAllowedMock).toHaveBeenNthCalledWith(1, {
      email: 'ada@example.com',
      clientAddress: '192.0.2.20',
    });
    expect(isSelfServicePasswordResetAllowedMock).toHaveBeenNthCalledWith(2, {
      email: 'ada@example.com',
      clientAddress: '192.0.2.20',
    });
  });

  it.each([
    ['disabled or unconfigured delivery', false, true, 'unavailable'],
    ['a rate-limited request', true, false, 'rate_limited'],
  ])(
    'keeps the same response for %s',
    async (_, available, allowed, outcome) => {
      isSelfServicePasswordResetAvailableMock.mockResolvedValue(available);
      isSelfServicePasswordResetAllowedMock.mockResolvedValue(allowed);

      const response = await POST(
        createRequest({ email: 'ada@example.com' }) as never,
      );

      expect(response.status).toBe(202);
      expect(requestSelfServicePasswordResetMock).not.toHaveBeenCalled();
      expect(loggerInfoMock).toHaveBeenCalledWith(
        expect.objectContaining({ outcome }),
        'Password reset request completed',
      );
    },
  );

  it('records a provider failure only after the generic response is created', async () => {
    requestSelfServicePasswordResetMock.mockResolvedValue('send_failed');

    const response = await POST(
      createRequest({ email: 'ada@example.com' }) as never,
    );
    expect(response.status).toBe(202);
    expect(loggerInfoMock).not.toHaveBeenCalled();

    await afterCallbacks[0]?.();

    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'send_failed' }),
      'Password reset request completed',
    );
  });

  it('keeps the same response for unknown account outcomes and malformed input', async () => {
    requestSelfServicePasswordResetMock.mockResolvedValue(undefined);
    const unknownResponse = await POST(
      createRequest({ email: 'unknown@example.com' }) as never,
    );
    const invalidResponse = await POST(
      createRequest({ email: 'nope' }) as never,
    );

    expect(unknownResponse.status).toBe(202);
    expect(invalidResponse.status).toBe(202);
    await expect(unknownResponse.json()).resolves.toEqual(
      await invalidResponse.json(),
    );
  });
});
