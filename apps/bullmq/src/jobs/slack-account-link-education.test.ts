import { z } from 'zod';

const {
  mockFindFirstSlackInstallation,
  mockFindFirstSlackUserMapping,
  mockFindFirstCloudJob,
  mockOpenConversation,
  mockPostMessage,
  mockRecordSlackConversationMessageBestEffort,
  andFn,
  eqFn,
} = vi.hoisted(() => ({
  mockFindFirstSlackInstallation: vi.fn(),
  mockFindFirstSlackUserMapping: vi.fn(),
  mockFindFirstCloudJob: vi.fn(),
  mockOpenConversation: vi.fn(),
  mockPostMessage: vi.fn(),
  mockRecordSlackConversationMessageBestEffort: vi.fn(),
  andFn: vi.fn(() => 'and-condition'),
  eqFn: vi.fn(() => 'eq-condition'),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: {
        findFirst: (...args: unknown[]) =>
          mockFindFirstSlackInstallation(...args),
      },
      slackUserMappings: {
        findFirst: (...args: unknown[]) =>
          mockFindFirstSlackUserMapping(...args),
      },
      cloudJobs: {
        findFirst: (...args: unknown[]) => mockFindFirstCloudJob(...args),
      },
    },
  },
  and: andFn,
  eq: eqFn,
  slackInstallations: {
    teamId: 'teamId',
    isActive: 'isActive',
  },
  slackUserMappings: {
    slackUserId: 'slackUserId',
    slackTeamId: 'slackTeamId',
  },
  cloudJobs: {
    userId: 'userId',
    requestedWorkKind: 'requestedWorkKind',
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  slackAccountLinkEducationRequestSchema: z.object({
    slackTeamId: z.string(),
    slackUserId: z.string(),
    userId: z.string(),
    mappingLinkedAt: z.coerce.date().optional(),
  }),
  recordSlackConversationMessageBestEffort:
    mockRecordSlackConversationMessageBestEffort,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class MockSlackNotifier {
    openConversation = mockOpenConversation;
    postMessage = mockPostMessage;
  },
}));

import {
  SLACK_ACCOUNT_LINK_EDUCATION_TEXT,
  slackAccountLinkEducationJob,
} from './slack-account-link-education';

const request = {
  slackTeamId: 'T123',
  slackUserId: 'U456',
  userId: 'user-1',
  mappingLinkedAt: new Date('2026-04-08T09:00:00.000Z'),
};

describe('slackAccountLinkEducationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstSlackInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    });
    mockFindFirstSlackUserMapping.mockResolvedValue({
      userId: 'user-1',
      updatedAt: request.mappingLinkedAt,
    });
    mockFindFirstCloudJob.mockResolvedValue(null);
    mockOpenConversation.mockResolvedValue('D123');
    mockPostMessage.mockResolvedValue('111.222');
  });

  it('posts the education DM when the mapping is still active', async () => {
    await slackAccountLinkEducationJob({ data: request } as never);

    expect(mockOpenConversation).toHaveBeenCalledWith('U456');
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'D123',
      text: SLACK_ACCOUNT_LINK_EDUCATION_TEXT,
    });
  });

  it('skips delivery when the Slack installation is missing or inactive', async () => {
    mockFindFirstSlackInstallation.mockResolvedValue(null);

    await slackAccountLinkEducationJob({ data: request } as never);

    expect(mockOpenConversation).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips delivery when the mapping was removed or reassigned', async () => {
    mockFindFirstSlackUserMapping.mockResolvedValue({
      userId: 'other-user',
      updatedAt: request.mappingLinkedAt,
    });

    await slackAccountLinkEducationJob({ data: request } as never);

    expect(mockOpenConversation).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips delivery when the mapping timestamp changed after scheduling', async () => {
    mockFindFirstSlackUserMapping.mockResolvedValue({
      userId: 'user-1',
      updatedAt: new Date('2026-04-08T09:25:00.000Z'),
    });

    await slackAccountLinkEducationJob({ data: request } as never);

    expect(mockOpenConversation).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('still delivers legacy jobs that do not include mappingLinkedAt', async () => {
    await slackAccountLinkEducationJob({
      data: {
        slackTeamId: request.slackTeamId,
        slackUserId: request.slackUserId,
        userId: request.userId,
      },
    } as never);

    expect(mockOpenConversation).toHaveBeenCalledWith('U456');
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'D123',
      text: SLACK_ACCOUNT_LINK_EDUCATION_TEXT,
    });
  });

  it('skips delivery when the user already created a question task', async () => {
    mockFindFirstCloudJob.mockResolvedValue({ id: 99 });

    await slackAccountLinkEducationJob({ data: request } as never);

    expect(mockOpenConversation).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('surfaces Slack delivery failures so BullMQ retries the job', async () => {
    mockPostMessage.mockRejectedValue(new Error('Slack unavailable'));

    await expect(
      slackAccountLinkEducationJob({ data: request } as never),
    ).rejects.toThrow('Slack unavailable');
  });
});
