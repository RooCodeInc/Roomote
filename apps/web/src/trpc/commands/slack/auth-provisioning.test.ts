import {
  automations,
  db,
  deploymentSettings,
  eq,
  slackAuthTokens,
  slackInstallationFactory,
  slackInstallations,
  slackUserMappings,
  userFactory,
  type SlackInstallation,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';

const { ensureChannel, education, decodeState, fetchMock } = vi.hoisted(() => ({
  ensureChannel: vi.fn(),
  education: vi.fn(),
  decodeState: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  ensureSlackManagerChannel: ensureChannel,
  shouldResumeSlackAuthThread: () => false,
  SlackNotifier: class {
    openConversation = async () => null;
    getUserDisplayName = async () => null;
    getWorkspaceMemberCount = async () => null;
  },
}));
vi.mock('@roomote/sdk/server', () => ({
  enqueueSlackAccountLinkEducation: education,
  recordSlackConversationMessageBestEffort: vi.fn(),
}));
vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  resolveEffectiveDeploymentEnvVars: async () => ({}),
}));
vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: async () => ({ TRPC_URL: 'http://localhost:13001' }),
}));
vi.mock('@/lib/server/slack-oauth-state', () => ({
  decodeSlackOAuthState: decodeState,
}));
vi.mock('@/lib/server/slack-redirect-uri', () => ({
  getSlackRedirectUri: () => 'http://localhost:3000/callback',
}));
vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession: vi.fn(),
}));
vi.mock('@/lib/server/sync-internal', () => ({ syncUser: vi.fn() }));
vi.mock('../tasks/by-id', () => ({ getTaskByIdCommand: vi.fn() }));
vi.mock('./create-app-from-manifest', () => ({
  createSlackAppFromManifestCommand: vi.fn(),
}));
vi.mock('./update-app-manifest', () => ({
  updateSlackAppManifestCommand: vi.fn(),
}));

import {
  completePendingSlackAuthenticationCommand,
  exchangeSlackOAuthCodeCommand,
  finishAuthenticateSlackAccountCommand,
} from './index';
import { provisionSlackManagerChannel } from './provision-manager-channel';

describe('Slack user authentication manager provisioning', () => {
  let installation: SlackInstallation;
  let auth: UserAuthSuccess;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    await db.delete(deploymentSettings);
    await db.delete(automations);
    await db.delete(slackAuthTokens);
    await db.delete(slackUserMappings);
    await db.delete(slackInstallations);
    const user = await userFactory.create();
    auth = { userId: user.id, isAdmin: true } as UserAuthSuccess;
    installation = await slackInstallationFactory.create({
      installedByUserId: user.id,
    });
    ensureChannel.mockResolvedValue('CMANAGERS');
    decodeState.mockImplementation(async (state: string) => ({
      mode: 'link_account',
      userId: state,
    }));
    fetchMock.mockImplementation(async (url: string) =>
      Response.json(
        url.endsWith('openid.connect.token')
          ? { ok: true, access_token: 'oidc-not-a-bot-token' }
          : {
              ok: true,
              sub: 'UAUTHUSER',
              'https://slack.com/team_id': installation.teamId,
              'https://slack.com/team_name': installation.teamName,
            },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const settings = () =>
    db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
    });
  const channels = () => db.query.slackInstallationChannels.findMany();
  const link = (userAuth: UserAuthSuccess = auth) =>
    finishAuthenticateSlackAccountCommand(userAuth, {
      code: 'code',
      state: userAuth.userId,
    });

  it('provisions after OIDC mapping with the owning bot token and leaves automations untouched', async () => {
    const [automation] = await db
      .insert(automations)
      .values({
        key: 'manager_stats',
        enabled: false,
        targets: [
          {
            provider: 'slack',
            targetKind: 'slack_channel',
            externalRef: 'CEXPLICIT',
          },
        ],
      })
      .returning();
    ensureChannel.mockImplementation(async () => {
      expect(await db.query.slackUserMappings.findFirst()).toMatchObject({
        userId: auth.userId,
      });
      return 'CMANAGERS';
    });
    expect(await link()).toMatchObject({ success: true });
    expect(ensureChannel).toHaveBeenCalledWith(installation.botAccessToken);
    expect(await settings()).toMatchObject({
      managerSlackChannelId: 'CMANAGERS',
    });
    expect(await channels()).toMatchObject([
      { slackInstallationId: installation.id, channelId: 'CMANAGERS' },
    ]);
    expect(await db.query.automations.findMany()).toEqual([automation]);
  });

  it('provisions after pending auth and retries unchanged mappings after a failure', async () => {
    await db.insert(slackAuthTokens).values({
      token: 'pending',
      slackUserId: 'UAUTHUSER',
      slackTeamId: installation.teamId,
      channel: 'CORIGINAL',
      threadTs: '1.0',
      originalText: '',
      expiresAt: new Date(Date.now() + 60_000),
    });
    ensureChannel.mockResolvedValueOnce(null);
    const complete = () =>
      completePendingSlackAuthenticationCommand(auth, {
        stateToken: 'pending',
      });
    expect(await complete()).toEqual({ success: true });
    expect(await settings()).toBeUndefined();
    expect(await complete()).toEqual({ success: true });
    expect(await settings()).toMatchObject({
      managerSlackChannelId: 'CMANAGERS',
    });
    expect(await complete()).toEqual({ success: true });
    expect(ensureChannel).toHaveBeenCalledTimes(2);
    expect(education).toHaveBeenCalledTimes(1);
  });

  it('retries OIDC provisioning even when multiple users are already mapped', async () => {
    ensureChannel.mockResolvedValueOnce(null);
    expect(await link()).toMatchObject({ success: true });
    const other = await userFactory.create();
    await db.insert(slackUserMappings).values({
      userId: other.id,
      slackUserId: 'UOTHER',
      slackTeamId: installation.teamId,
    });
    expect(await link()).toMatchObject({ success: true });
    expect(await settings()).toMatchObject({
      managerSlackChannelId: 'CMANAGERS',
    });
    expect(ensureChannel).toHaveBeenCalledTimes(2);
  });

  it.each([
    { managerSlackChannelId: 'CEXPLICIT' },
    { managerDiscordChannelId: '123456' },
  ])(
    'preserves pre-existing manager configuration %j without Slack calls',
    async (config) => {
      await db.insert(deploymentSettings).values(config);
      await provisionSlackManagerChannel(installation);
      expect(await settings()).toMatchObject(config);
      expect(ensureChannel).not.toHaveBeenCalled();
      expect(await channels()).toEqual([]);
    },
  );

  it.each([
    { managerSlackChannelId: 'CEXPLICIT' },
    { managerDiscordChannelId: '123456' },
  ])(
    'atomically preserves manager configuration selected during Slack calls %j',
    async (config) => {
      await db.insert(deploymentSettings).values({});
      ensureChannel.mockImplementation(async () => {
        await db
          .update(deploymentSettings)
          .set(config)
          .where(eq(deploymentSettings.id, 'default'));
        return 'CMANAGERS';
      });
      await provisionSlackManagerChannel(installation);
      expect(await settings()).toMatchObject({
        managerSlackChannelId: null,
        ...config,
      });
      expect(await channels()).toMatchObject([
        { slackInstallationId: installation.id, channelId: 'CMANAGERS' },
      ]);
    },
  );

  it('handles concurrent same-user auth and idempotent channel registration', async () => {
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    ensureChannel.mockImplementation(async () => {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
      return 'CMANAGERS';
    });
    const results = await Promise.all([link(), link()]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(await db.query.slackUserMappings.findMany()).toHaveLength(1);
    expect(education).toHaveBeenCalledTimes(1);
    expect(await channels()).toHaveLength(1);
    expect(await settings()).toMatchObject({
      managerSlackChannelId: 'CMANAGERS',
    });
  });

  it('allows only one owner when different users race to map the same Slack account', async () => {
    const other = await userFactory.create();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await Promise.all([
      link(),
      link({ ...auth, userId: other.id }),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toEqual([
      expect.objectContaining({
        error: expect.stringContaining('already linked'),
      }),
    ]);
    expect(await db.query.slackUserMappings.findMany()).toHaveLength(1);
    expect(ensureChannel).toHaveBeenCalledTimes(1);
  });

  it('does not provision when mapping is rejected', async () => {
    const other = await userFactory.create();
    await db.insert(slackUserMappings).values({
      userId: other.id,
      slackUserId: 'UAUTHUSER',
      slackTeamId: installation.teamId,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await link()).toMatchObject({ success: false });
    expect(ensureChannel).not.toHaveBeenCalled();
  });

  it('does not provision on app installation even when an installing user is mapped', async () => {
    decodeState.mockResolvedValue({ mode: 'install' });
    fetchMock.mockResolvedValue(
      Response.json({
        ok: true,
        access_token: 'installation-bot-token',
        bot_user_id: 'UBOT',
        team: { id: installation.teamId, name: installation.teamName },
        app_id: installation.appId,
        authed_user: { id: 'UAUTHUSER' },
      }),
    );
    expect(
      await exchangeSlackOAuthCodeCommand(auth, {
        code: 'install',
        state: 'install',
      }),
    ).toMatchObject({ success: true });
    expect(await db.query.slackUserMappings.findFirst()).toMatchObject({
      userId: auth.userId,
    });
    expect(ensureChannel).not.toHaveBeenCalled();
  });

  it('contains unexpected provisioning errors without breaking auth or logging credentials', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ensureChannel.mockRejectedValue(
      new Error('network failure containing bot-token-secret'),
    );
    expect(await link()).toMatchObject({ success: true });
    expect(await settings()).toBeUndefined();
    expect(await channels()).toEqual([]);
    expect(warning.mock.calls.flat().join(' ')).not.toContain(
      'bot-token-secret',
    );
  });

  it('rolls back the manager write if registration fails and permits a later retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await provisionSlackManagerChannel({
      ...installation,
      id: crypto.randomUUID(),
    });
    expect(await settings()).toBeUndefined();
    await provisionSlackManagerChannel(installation);
    expect(await settings()).toMatchObject({
      managerSlackChannelId: 'CMANAGERS',
    });
  });

  it('does not provision an inactive installation', async () => {
    await provisionSlackManagerChannel({ ...installation, isActive: false });
    expect(ensureChannel).not.toHaveBeenCalled();
  });
});
