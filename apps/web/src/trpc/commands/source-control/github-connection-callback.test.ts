import type { UserAuthSuccess } from '@/types';
import { signConnectionState } from '@/lib/server/source-control-connection-state';
const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  sync: vi.fn(),
  manifest: vi.fn(),
  pending: vi.fn(),
  start: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock('@/lib/server/env', () => ({
  getBetterAuthSecret: () => 'github-connection-test-secret',
}));
vi.mock('@/lib/server/source-control-connection-attempt', () => ({
  completeConnectionAttempt: mocks.complete,
}));
vi.mock('@roomote/sdk/server', () => ({
  reconcileSourceControlConnectionRequests: mocks.reconcile,
}));
vi.mock('../github/mutations', () => ({
  syncGitHubInstallationCommand: mocks.sync,
  finishCreateGitHubAppManifestCommand: mocks.manifest,
  finishCreateGitHubInstallationCommand: mocks.pending,
  startCreateGitHubInstallationCommand: mocks.start,
}));
import { githubConnectionCallbackCommand } from './github-connection-callback';

describe('GitHub Session callback routing', () => {
  const auth = { userId: 'admin', isAdmin: true } as UserAuthSuccess;
  const requestId = '11111111-1111-4111-8111-111111111111';
  const returnTarget =
    '/sessions/22222222-2222-4222-8222-222222222222?connectionRequest=' +
    requestId;
  const state = (purpose: 'github-install' | 'github-manifest') =>
    signConnectionState({
      actorUserId: auth.userId,
      provider: 'github',
      purpose,
      requestId,
      revision: 1,
      returnTarget,
    });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.complete.mockImplementation(async (_auth, _input, run) => ({
      result: await run(),
      returnTarget,
    }));
    mocks.sync.mockResolvedValue({ success: true });
    mocks.pending.mockResolvedValue({ success: true });
    mocks.manifest.mockResolvedValue({ success: true });
    mocks.start.mockResolvedValue({
      success: true,
      url: 'https://github.com/apps/example/installations/new',
    });
  });
  it('uses authoritative installation sync for a bound install callback', async () => {
    const token = state('github-install');
    expect(
      await githubConnectionCallbackCommand(auth, {
        state: token,
        action: 'install',
        installationId: 42,
      }),
    ).toEqual({ success: true, returnTarget });
    expect(mocks.sync).toHaveBeenCalledWith(auth, { installationId: 42 });
    expect(mocks.complete).toHaveBeenCalledWith(
      auth,
      { provider: 'github', state: token, reconcile: true },
      expect.any(Function),
    );
  });
  it('keeps pending approval non-ready and returns to the same Session', async () => {
    await githubConnectionCallbackCommand(auth, {
      state: state('github-install'),
      action: 'request',
      code: 'code',
    });
    expect(mocks.pending).toHaveBeenCalledWith(auth, { code: 'code' });
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.reconcile).toHaveBeenCalledWith(
      { provider: 'github', requestId },
      { syncState: 'pending' },
    );
  });
  it('starts a fresh bound install after manifest creation instead of treating credential save as readiness', async () => {
    const result = await githubConnectionCallbackCommand(auth, {
      state: state('github-manifest'),
      action: 'manifest',
      code: 'code',
    });
    expect(result).toMatchObject({ success: true, returnTarget });
    expect(mocks.start).toHaveBeenCalledWith(auth, {
      mode: 'github-app-install',
      connectionRequestId: requestId,
      redirect: returnTarget,
    });
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it('rejects a changed actor or callback purpose before invoking provider actions', async () => {
    const token = state('github-install');
    await expect(
      githubConnectionCallbackCommand(
        { ...auth, userId: 'different-admin' },
        { state: token, action: 'install', installationId: 42 },
      ),
    ).rejects.toThrow();
    await expect(
      githubConnectionCallbackCommand(auth, {
        state: token,
        action: 'manifest',
        code: 'code',
      }),
    ).rejects.toThrow();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
