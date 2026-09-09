import {
  signConnectionState,
  verifyConnectionState,
} from './source-control-connection-state';

vi.mock('./env', () => ({
  getBetterAuthSecret: () => 'connection-state-test-secret',
}));

describe('source-control authorization state', () => {
  const input = {
    actorUserId: 'admin',
    provider: 'gitlab' as const,
    returnTarget: '/sessions/example?connectionRequest=example',
    requestId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
  };
  afterEach(() => vi.useRealTimers());
  it('binds provider, actor, exact request and revision rather than a shared return cookie', () => {
    const first = signConnectionState(input);
    const second = signConnectionState({
      ...input,
      requestId: '22222222-2222-4222-8222-222222222222',
      returnTarget: '/sessions/second',
      revision: 2,
    });
    expect(first).not.toBe(second);
    expect(verifyConnectionState(first, 'admin', 'gitlab')).toMatchObject(
      input,
    );
    expect(verifyConnectionState(second, 'admin', 'gitlab')).toMatchObject({
      requestId: '22222222-2222-4222-8222-222222222222',
      revision: 2,
    });
    expect(() =>
      verifyConnectionState(first, 'other-admin', 'gitlab'),
    ).toThrow();
    expect(() => verifyConnectionState(first, 'admin', 'gitea')).toThrow();
    const parts = first.split('.');
    parts[1] = Buffer.from(
      JSON.stringify({ ...input, actorUserId: 'other-admin' }),
    ).toString('base64url');
    expect(() =>
      verifyConnectionState(parts.join('.'), 'other-admin', 'gitlab'),
    ).toThrow();
  });
  it('enforces the provider lifetime and rejects future state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = signConnectionState(input);
    const github = signConnectionState({ ...input, provider: 'github' });
    vi.advanceTimersByTime(600001);
    expect(() => verifyConnectionState(token, 'admin', 'gitlab')).toThrow();
    expect(verifyConnectionState(github, 'admin', 'github')).toBeTruthy();
    vi.advanceTimersByTime(3600000);
    expect(() => verifyConnectionState(github, 'admin', 'github')).toThrow();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    expect(() => verifyConnectionState(token, 'admin', 'gitlab')).toThrow();
  });
});
