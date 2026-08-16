import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

const state = vi.hoisted(() => ({
  cloudEnabled: true,
  supportEmail: 'support@roomote.example',
  installation: null as null | {
    teamId: string;
    botAccessToken: string;
    scopes: { bot: string[] };
  },
  metadata: {} as Record<string, unknown>,
}));

const mocks = vi.hoisted(() => ({
  createPrivateChannel: vi.fn(),
  inviteSharedChannel: vi.fn(),
  getSlackConnectChannelStatus: vi.fn(),
  resolveChannelId: vi.fn(),
  insert: vi.fn(),
  updateMetadata: vi.fn(),
  releaseLock: vi.fn(),
  renewLock: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn().mockImplementation(function () {
    return {
      createPrivateChannel: mocks.createPrivateChannel,
      inviteSharedChannel: mocks.inviteSharedChannel,
      getSlackConnectChannelStatus: mocks.getSlackConnectChannelStatus,
      resolveChannelId: mocks.resolveChannelId,
    };
  }),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: {
        findFirst: vi.fn(() => Promise.resolve(state.installation)),
      },
      deploymentSettings: {
        findFirst: vi.fn(() => Promise.resolve({ metadata: state.metadata })),
      },
    },
    insert: mocks.insert,
  },
  deploymentSettings: { id: 'id', metadata: 'metadata' },
  slackInstallations: { isActive: 'isActive', updatedAt: 'updatedAt' },
  desc: vi.fn((value) => value),
  eq: vi.fn(() => ({})),
  sql: vi.fn(),
}));

vi.mock('@/lib/server/env', () => ({
  Env: {
    get R_CLOUD_ENABLED() {
      return state.cloudEnabled;
    },
    get R_SLACK_CONNECT_SUPPORT_EMAIL() {
      return state.supportEmail;
    },
  },
  isRoomoteCloudEnabled: () => state.cloudEnabled,
}));

vi.mock('@/lib/slack-app-manifest', () => ({
  SLACK_SUPPORT_CHANNEL_BOT_SCOPES: [
    'groups:write',
    'conversations.connect:write',
  ],
}));

vi.mock('@roomote/redis', () => ({
  REDIS_KEYS: { SLACK_SUPPORT_CHANNEL_CREATE: 'slack:support-channel:create' },
  acquireRedisLock: vi.fn(async () =>
    Object.assign(mocks.releaseLock, { renew: mocks.renewLock }),
  ),
}));

import {
  createSlackSupportChannelCommand,
  getSlackSupportChannelStatusCommand,
} from './support-channel';

function buildAuth(overrides: Partial<UserAuthSuccess> = {}): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'admin-1',
    isAdmin: true,
    name: 'Admin',
    primaryEmail: 'admin@example.com',
    featureFlags: {} as Record<FeatureFlag, boolean>,
    resource: {},
    ...overrides,
  } as UserAuthSuccess;
}

describe('Slack support channel commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cloudEnabled = true;
    state.supportEmail = 'support@roomote.example';
    state.metadata = {};
    state.installation = {
      teamId: 'T123456789',
      botAccessToken: 'xoxb-test',
      scopes: {
        bot: ['groups:write', 'conversations.connect:write'],
      },
    };
    mocks.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoUpdate: mocks.updateMetadata.mockResolvedValue(undefined),
      }),
    }));
    mocks.resolveChannelId.mockResolvedValue(null);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.renewLock.mockResolvedValue(true);
  });

  it('stays unavailable outside Roomote Cloud', async () => {
    state.cloudEnabled = false;

    await expect(
      getSlackSupportChannelStatusCommand(buildAuth()),
    ).resolves.toMatchObject({ eligible: false, state: 'unavailable' });
  });

  it('requires both narrow Slack scopes', async () => {
    state.installation!.scopes.bot = ['groups:write'];

    await expect(
      getSlackSupportChannelStatusCommand(buildAuth()),
    ).resolves.toMatchObject({ eligible: true, state: 'needs_permissions' });
    expect(mocks.createPrivateChannel).not.toHaveBeenCalled();
  });

  it('creates, persists, and invites a dedicated private channel', async () => {
    mocks.createPrivateChannel.mockResolvedValue({
      success: true,
      data: { id: 'C123SUPPORT', name: 'roomote-support' },
    });
    mocks.getSlackConnectChannelStatus.mockResolvedValue({
      success: true,
      data: 'not_shared',
    });
    mocks.inviteSharedChannel.mockResolvedValue({
      success: true,
      data: { inviteId: 'I123' },
    });

    const result = await createSlackSupportChannelCommand(buildAuth());

    expect(mocks.createPrivateChannel).toHaveBeenCalledWith(
      'roomote-support-456789',
    );
    expect(mocks.inviteSharedChannel).toHaveBeenCalledWith({
      channelId: 'C123SUPPORT',
      email: 'support@roomote.example',
    });
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'invitation_pending',
      channelId: 'C123SUPPORT',
      channelName: 'roomote-support-456789',
    });
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('resumes a pending invitation without creating a duplicate channel', async () => {
    state.metadata = {
      slackSupportChannel: {
        teamId: 'T123456789',
        channelId: 'C123SUPPORT',
        channelName: 'roomote-support',
        inviteId: 'I123',
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
    };
    mocks.getSlackConnectChannelStatus.mockResolvedValue({
      success: true,
      data: 'pending',
    });

    const result = await createSlackSupportChannelCommand(buildAuth());

    expect(mocks.createPrivateChannel).not.toHaveBeenCalled();
    expect(mocks.inviteSharedChannel).not.toHaveBeenCalled();
    expect(result.state).toBe('invitation_pending');
  });

  it('recreates a support channel that was deleted from Slack', async () => {
    state.metadata = {
      slackSupportChannel: {
        teamId: 'T123456789',
        channelId: 'C123DELETED',
        channelName: 'roomote-support',
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
    };
    mocks.getSlackConnectChannelStatus.mockResolvedValue({
      success: true,
      data: 'not_found',
    });
    mocks.createPrivateChannel.mockResolvedValue({
      success: true,
      data: { id: 'C123REPLACEMENT', name: 'roomote-support-456789' },
    });
    mocks.inviteSharedChannel.mockResolvedValue({
      success: true,
      data: { inviteId: 'I456' },
    });

    const result = await createSlackSupportChannelCommand(buildAuth());

    expect(mocks.createPrivateChannel).toHaveBeenCalled();
    expect(mocks.inviteSharedChannel).toHaveBeenCalledWith({
      channelId: 'C123REPLACEMENT',
      email: 'support@roomote.example',
    });
    expect(result.channelId).toBe('C123REPLACEMENT');
  });

  it('does not resend an invitation when channel status is unknown', async () => {
    state.metadata = {
      slackSupportChannel: {
        teamId: 'T123456789',
        channelId: 'C123SUPPORT',
        channelName: 'roomote-support-456789',
        inviteSentAt: '2026-08-02T00:00:00.000Z',
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
    };
    mocks.getSlackConnectChannelStatus.mockResolvedValue({
      success: false,
      error: 'request_timeout',
    });

    const result = await createSlackSupportChannelCommand(buildAuth());

    expect(result.state).toBe('action_needed');
    expect(mocks.inviteSharedChannel).not.toHaveBeenCalled();
  });

  it('recovers the deterministic channel after a concurrent create', async () => {
    mocks.resolveChannelId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('C123RECOVERED');
    mocks.createPrivateChannel.mockResolvedValue({
      success: false,
      error: 'name_taken',
    });
    mocks.inviteSharedChannel.mockResolvedValue({
      success: true,
      data: { inviteId: null },
    });

    const result = await createSlackSupportChannelCommand(buildAuth());

    expect(mocks.createPrivateChannel).toHaveBeenCalledTimes(1);
    expect(mocks.inviteSharedChannel).toHaveBeenCalledWith({
      channelId: 'C123RECOVERED',
      email: 'support@roomote.example',
    });
    expect(result).toMatchObject({
      state: 'invitation_pending',
      channelId: 'C123RECOVERED',
    });
  });

  it('stops before inviting when the renewable lock is lost', async () => {
    mocks.createPrivateChannel.mockResolvedValue({
      success: true,
      data: { id: 'C123SUPPORT', name: 'roomote-support-456789' },
    });
    mocks.renewLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await createSlackSupportChannelCommand(buildAuth());

    expect(result).toMatchObject({
      state: 'action_needed',
      message: 'Support channel setup lost its lock. Try again.',
    });
    expect(mocks.inviteSharedChannel).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });
});
