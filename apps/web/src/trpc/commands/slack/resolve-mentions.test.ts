import {
  db,
  eq,
  slackInstallationFactory,
  slackInstallations,
  userFactory,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';

const { getChannelName, getUserDisplayNames, findAccessibleFastSession } =
  vi.hoisted(() => ({
    getChannelName: vi.fn(),
    getUserDisplayNames: vi.fn(),
    findAccessibleFastSession: vi.fn(),
  }));

vi.mock('@roomote/slack', () => ({
  SlackChannelInfoCache: class {},
  SlackNotifier: class {
    getChannelName = getChannelName;
    getUserDisplayNames = getUserDisplayNames;
  },
  shouldResumeSlackAuthThread: () => false,
}));
vi.mock('@roomote/sdk/server', () => ({
  enqueueSlackAccountLinkEducation: vi.fn(),
  recordSlackConversationMessageBestEffort: vi.fn(),
}));
vi.mock('@/lib/server/fast-sessions', () => ({
  findAccessibleFastSession,
}));
vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: vi.fn(),
}));
vi.mock('@/lib/server/slack-oauth-state', () => ({
  createSignedSlackInstallState: vi.fn(),
  createSignedSlackLinkAccountState: vi.fn(),
  decodeSlackOAuthState: vi.fn(),
}));
vi.mock('@/lib/server/slack-redirect-uri', () => ({
  getSlackRedirectUri: vi.fn(),
}));
vi.mock('@/lib/server/sync-internal', () => ({ syncUser: vi.fn() }));
vi.mock('../tasks/by-id', () => ({ getTaskByIdCommand: vi.fn() }));
vi.mock('./create-app-from-manifest', () => ({
  createSlackAppFromManifestCommand: vi.fn(),
}));
vi.mock('./update-app-manifest', () => ({
  updateSlackAppManifestCommand: vi.fn(),
}));

import { resolveSlackUsersCommand } from './index';

describe('resolveSlackUsersCommand', () => {
  let installationId: string;
  let auth: UserAuthSuccess;

  beforeEach(async () => {
    vi.resetAllMocks();
    const user = await userFactory.create();
    auth = { userId: user.id, isAdmin: false } as UserAuthSuccess;
    const teamId = `T${crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const installation = await slackInstallationFactory.create({
      installedByUserId: user.id,
      teamId,
      teamDomain: 'acme-team',
    });
    installationId = installation.id;
    findAccessibleFastSession.mockResolvedValue({
      surface: 'slack',
      workspaceId: teamId,
    });
    getUserDisplayNames.mockResolvedValue(new Map([['U123', 'Maya']]));
    getChannelName.mockResolvedValue('ops');
  });

  afterEach(async () => {
    await db
      .delete(slackInstallations)
      .where(eq(slackInstallations.id, installationId));
  });

  it('resolves assistant user and channel references with workspace links', async () => {
    const result = await resolveSlackUsersCommand(auth, {
      scope: { kind: 'session', sessionId: 'session-1' },
      userIds: ['U123'],
      channelIds: ['C456'],
    });

    expect(result).toEqual({
      users: {
        U123: {
          name: 'Maya',
          profileUrl: 'https://acme-team.slack.com/team/U123',
        },
      },
      channels: {
        C456: {
          name: 'ops',
          url: 'https://acme-team.slack.com/archives/C456',
        },
      },
    });
    expect(getUserDisplayNames).toHaveBeenCalledWith(['U123']);
    expect(getChannelName).toHaveBeenCalledWith('C456');
  });
});
