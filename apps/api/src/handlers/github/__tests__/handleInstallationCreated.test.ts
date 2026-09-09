import {
  db,
  eq,
  githubInstallations,
  githubInstallationFactory,
  githubPendingInstallations,
  githubUserMappings,
  userFactory,
  users,
} from '@roomote/db/server';
import { encryptJSON } from '@roomote/db/encryption';
const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  sync: vi.fn(),
  installation: vi.fn(),
  notify: vi.fn(),
  backfill: vi.fn(),
  reconcile: vi.fn(),
  syncStartedAt: vi.fn(async () => '2026-09-08T12:00:00.123456Z'),
  configuredApp: null as null | {
    value: string;
    createdByUserId: string;
    lastUpdatedByUserId: string | null;
  },
}));
vi.mock('@roomote/github', () => ({
  completePendingGitHubInstallation: mocks.pending,
  getGitHubInstallation: mocks.installation,
  syncGitHubInstallation: mocks.sync,
}));
vi.mock('@roomote/sdk/server', () => ({
  sendUserDirectMessageBestEffort: mocks.notify,
  reconcileSourceControlConnectionRequests: mocks.reconcile,
  getSourceControlSyncStartedAt: mocks.syncStartedAt,
}));
vi.mock('@roomote/sdk/server/request-instance-ping', () => ({
  requestBrainBackfill: mocks.backfill,
}));
vi.mock('@roomote/env', async (original) => ({
  ...(await original<typeof import('@roomote/env')>()),
  getEncryptionKey: () => 'installation-created-test-key',
  Env: { R_APP_URL: 'https://roomote.example.com' },
}));
vi.mock('@roomote/db/server', async (original) => ({
  ...(await original<typeof import('@roomote/db/server')>()),
  resolveDeploymentEnvVar: async () => '77',
}));
import { handleInstallationCreated } from '../handleInstallationCreated';
import type { WebhookInstallationCreated } from '../types';

describe('installation.created authoritative synchronization', () => {
  let admin: Awaited<ReturnType<typeof userFactory.create>>;
  let member: Awaited<ReturnType<typeof userFactory.create>>;
  let installationId: number;
  let accountId: number;
  let senderId: number;
  const payload = () =>
    ({
      installation: {
        id: installationId,
        app_id: 77,
        account: { id: accountId },
      },
      sender: { id: senderId },
    }) as WebhookInstallationCreated;
  const pending = () =>
    db
      .insert(githubPendingInstallations)
      .values({ appId: accountId, requestedByUserId: admin.id, payload: {} });
  beforeEach(async () => {
    vi.clearAllMocks();
    admin = await userFactory.create({ role: 'admin' });
    member = await userFactory.create({ role: 'member' });
    installationId = Math.floor(Math.random() * 1e12);
    accountId = installationId + 1;
    senderId = installationId + 2;
    mocks.configuredApp = null;
    vi.spyOn(db.query.environmentVariables, 'findFirst').mockImplementation(
      () => Promise.resolve(mocks.configuredApp) as never,
    );
    mocks.installation.mockResolvedValue({
      id: installationId,
      app_id: 77,
      account: { id: accountId },
      suspended_at: null,
    });
    mocks.sync.mockResolvedValue({
      success: true,
      githubInstallation: { accountLogin: 'example' },
      repositories: [],
    });
    mocks.pending.mockResolvedValue({
      success: true,
      githubInstallation: { accountLogin: 'example' },
      repositories: [],
      requestedByUserId: admin.id,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId));
    await db
      .delete(githubPendingInstallations)
      .where(eq(githubPendingInstallations.appId, accountId));
    await db.delete(users).where(eq(users.id, admin.id));
    await db.delete(users).where(eq(users.id, member.id));
  });
  it('synchronizes a direct install without a pending request or personal link using the current App configuring admin', async () => {
    mocks.configuredApp = {
      value: encryptJSON('77'),
      createdByUserId: admin.id,
      lastUpdatedByUserId: null,
    };
    expect(await handleInstallationCreated(payload())).toEqual({
      status: 'ok',
    });
    expect(mocks.sync).toHaveBeenCalledWith({
      userId: admin.id,
      installationId,
    });
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.syncStartedAt).toHaveBeenCalledWith('github');
    expect(mocks.syncStartedAt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installation.mock.invocationCallOrder[0]!,
    );
    expect(mocks.reconcile).toHaveBeenCalledWith(
      { provider: 'github' },
      {
        successfulSync: {
          startedAt: '2026-09-08T12:00:00.123456Z',
          repositoryFullNames: [],
        },
      },
    );
    expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.sync.mock.invocationCallOrder[0]!,
    );
    expect(mocks.backfill).toHaveBeenCalledWith('github-installation-created');
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('supports a verified linked admin sender when the App credentials were configured at runtime', async () => {
    await db.insert(githubUserMappings).values({
      githubLogin: 'installer',
      githubUserId: senderId,
      userId: admin.id,
    });
    expect((await handleInstallationCreated(payload())).status).toBe('ok');
    expect(mocks.sync).toHaveBeenCalledWith({
      userId: admin.id,
      installationId,
    });
  });
  it('reuses a known installation actor without inventing attribution on redelivery', async () => {
    await githubInstallationFactory.create({
      installationId,
      appId: 77,
      installedByUserId: admin.id,
    });
    expect((await handleInstallationCreated(payload())).status).toBe('ok');
    expect(mocks.sync).toHaveBeenCalledWith({
      userId: admin.id,
      installationId,
    });
  });
  it('retains pending-approval completion and notifies only its recorded requester', async () => {
    await pending();
    expect(await handleInstallationCreated(payload())).toEqual({
      status: 'ok',
    });
    expect(mocks.pending).toHaveBeenCalledWith(installationId);
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: admin.id }),
    );
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    'never reconciles or backfills after sync failure (pending=%s)',
    async (hasPending) => {
      if (hasPending) await pending();
      else
        mocks.configuredApp = {
          value: encryptJSON('77'),
          createdByUserId: admin.id,
          lastUpdatedByUserId: null,
        };
      mocks.pending.mockResolvedValue({
        success: false,
        error: 'provider failure',
      });
      mocks.sync.mockResolvedValue({
        success: false,
        error: 'provider failure',
      });
      expect(await handleInstallationCreated(payload())).toEqual({
        status: 'error',
        message: 'installation_sync_failed',
      });
      expect(mocks.reconcile).not.toHaveBeenCalled();
      expect(mocks.backfill).not.toHaveBeenCalled();
      expect(mocks.notify).not.toHaveBeenCalled();
    },
  );
  it('rejects a webhook for a different App before making provider calls', async () => {
    const foreign = payload();
    foreign.installation.app_id = 88;
    expect((await handleInstallationCreated(foreign)).message).toBe(
      'installation_app_mismatch',
    );
    expect(mocks.installation).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it.each(['app', 'id', 'account', 'suspended'])(
    'rejects mismatched authoritative installation %s',
    async (mismatch) => {
      mocks.installation.mockResolvedValue({
        id: mismatch === 'id' ? installationId + 9 : installationId,
        app_id: mismatch === 'app' ? 88 : 77,
        account: { id: mismatch === 'account' ? accountId + 9 : accountId },
        suspended_at: mismatch === 'suspended' ? '2026-01-01' : null,
      });
      expect((await handleInstallationCreated(payload())).message).toBe(
        'installation_unavailable',
      );
      expect(mocks.pending).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
      expect(mocks.reconcile).not.toHaveBeenCalled();
    },
  );
  it('fails closed when App-auth installation lookup rejects the id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.installation.mockRejectedValue(new Error('Not Found'));
    expect((await handleInstallationCreated(payload())).status).toBe('error');
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'member', 'deleted', 'other-app'])(
    'does not select an arbitrary admin when actor attribution is %s',
    async (scenario) => {
      if (scenario !== 'unknown')
        mocks.configuredApp = {
          value: encryptJSON(scenario === 'other-app' ? '88' : '77'),
          createdByUserId: scenario === 'member' ? member.id : admin.id,
          lastUpdatedByUserId: null,
        };
      if (scenario === 'deleted')
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, admin.id));
      expect((await handleInstallationCreated(payload())).message).toBe(
        'installation_sync_actor_required',
      );
      expect(mocks.sync).not.toHaveBeenCalled();
      expect(mocks.reconcile).not.toHaveBeenCalled();
    },
  );
});
