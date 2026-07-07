import { z } from 'zod';

const {
  mockGetBackgroundAgentSettingsForOrg,
  mockFindFirstSlackInstallation,
  mockFindFirstSlackUserMapping,
  mockSetPendingPrompt,
  mockClearPendingPrompt,
  mockGetPromptSentMarker,
  mockSetPromptSentMarker,
  mockBuildPromptBlocks,
  mockPostMessage,
  mockRecordSlackConversationMessageBestEffort,
  andFn,
  eqFn,
} = vi.hoisted(() => ({
  mockGetBackgroundAgentSettingsForOrg: vi.fn(),
  mockFindFirstSlackInstallation: vi.fn(),
  mockFindFirstSlackUserMapping: vi.fn(),
  mockSetPendingPrompt: vi.fn(),
  mockClearPendingPrompt: vi.fn(),
  mockGetPromptSentMarker: vi.fn(),
  mockSetPromptSentMarker: vi.fn(),
  mockBuildPromptBlocks: vi.fn(() => [{ type: 'section' }]),
  mockPostMessage: vi.fn(),
  mockRecordSlackConversationMessageBestEffort: vi.fn(),
  andFn: vi.fn(() => 'and-condition'),
  eqFn: vi.fn(() => 'eq-condition'),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      ...actual.Env,
      ROOMOTE_APP_URL: 'https://app.roomote.example',
    },
  };
});

vi.mock('node:crypto', () => ({
  randomUUID: () => 'nonce-123',
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
    },
  },
  getBackgroundAgentSettingsForDeployment: (...args: unknown[]) =>
    mockGetBackgroundAgentSettingsForOrg(...args),
  and: andFn,
  eq: eqFn,
  slackInstallations: {
    teamId: 'teamId',
    isActive: 'isActive',
  },
  slackUserMappings: {
    slackTeamId: 'slackTeamId',
    slackUserId: 'slackUserId',
  },
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class MockSlackNotifier {
    postMessage = mockPostMessage;
  },
  buildSuggestedTasksOnboardingFollowupPromptBlocks: mockBuildPromptBlocks,
  clearPendingSuggestedTasksOnboardingFollowupPrompt: mockClearPendingPrompt,
  getSuggestedTasksOnboardingFollowupPromptSentMarker: mockGetPromptSentMarker,
  setPendingSuggestedTasksOnboardingFollowupPrompt: mockSetPendingPrompt,
  setSuggestedTasksOnboardingFollowupPromptSentMarker: mockSetPromptSentMarker,
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT:
    'Want to receive more ideas like this once in a while? I can make them thematic or cover a specific part of the product, to align with your priorities.',
}));

vi.mock('@roomote/sdk/server', () => ({
  slackSuggestedTasksOnboardingFollowupRequestSchema: z.object({
    slackTeamId: z.string(),
    slackUserId: z.string(),
    channelId: z.string(),
    threadTs: z.string(),
    sourceTaskId: z.string(),
  }),
  recordSlackConversationMessageBestEffort:
    mockRecordSlackConversationMessageBestEffort,
}));

import { slackSuggestedTasksOnboardingFollowupJob } from './slack-suggested-tasks-onboarding-followup';

const request = {
  slackTeamId: 'T123',
  slackUserId: 'U456',
  channelId: 'D789',
  threadTs: '555.000',
  sourceTaskId: 'task-suggestions-1',
};

describe('slackSuggestedTasksOnboardingFollowupJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBackgroundAgentSettingsForOrg.mockResolvedValue({
      suggesterFrequency: 'off',
    });
    mockFindFirstSlackInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    });
    mockFindFirstSlackUserMapping.mockResolvedValue({ id: 'mapping-1' });
    mockSetPendingPrompt.mockResolvedValue(undefined);
    mockClearPendingPrompt.mockResolvedValue(undefined);
    mockGetPromptSentMarker.mockResolvedValue(null);
    mockSetPromptSentMarker.mockResolvedValue(undefined);
    mockPostMessage.mockResolvedValue('555.001');
  });

  it('posts the threaded follow-up prompt when the suggester is still off', async () => {
    await slackSuggestedTasksOnboardingFollowupJob({ data: request } as never);

    expect(mockSetPendingPrompt).toHaveBeenCalledWith({
      threadId: '555.000',
      payload: {
        slackTeamId: 'T123',
        slackUserId: 'U456',
        channelId: 'D789',
        threadTs: '555.000',
        nonce: 'nonce-123',
        settingsUrl: 'https://app.roomote.example/automations#suggest-ideas',
      },
    });
    expect(mockBuildPromptBlocks).toHaveBeenCalledWith({
      settingsUrl: 'https://app.roomote.example/automations#suggest-ideas',
      nonce: 'nonce-123',
    });
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'D789',
      thread_ts: '555.000',
      text: 'Want to receive more ideas like this once in a while? I can make them thematic or cover a specific part of the product, to align with your priorities.',
      blocks: [{ type: 'section' }],
    });
    expect(mockClearPendingPrompt).not.toHaveBeenCalled();
    expect(mockSetPromptSentMarker).toHaveBeenCalledWith({
      threadId: '555.000',
      marker: {
        channelId: 'D789',
        messageTs: '555.001',
        promptSentAt: expect.any(String),
        pendingPrompt: {
          slackTeamId: 'T123',
          slackUserId: 'U456',
          channelId: 'D789',
          threadTs: '555.000',
          nonce: 'nonce-123',
          settingsUrl: 'https://app.roomote.example/automations#suggest-ideas',
        },
      },
    });
  });

  it('skips delivery when the suggester is already enabled', async () => {
    mockGetBackgroundAgentSettingsForOrg.mockResolvedValue({
      suggesterFrequency: 'weekly',
    });

    await slackSuggestedTasksOnboardingFollowupJob({ data: request } as never);

    expect(mockSetPendingPrompt).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('restores pending prompt and skips duplicate delivery when a sent marker exists', async () => {
    mockGetPromptSentMarker.mockResolvedValue({
      channelId: 'D789',
      messageTs: '555.001',
      promptSentAt: '2026-04-10T10:00:00.000Z',
      pendingPrompt: {
        slackTeamId: 'T123',
        slackUserId: 'U456',
        channelId: 'D789',
        threadTs: '555.000',
        nonce: 'nonce-123',
        settingsUrl: 'https://app.roomote.example/automations#suggest-ideas',
      },
    });

    await slackSuggestedTasksOnboardingFollowupJob({ data: request } as never);

    expect(mockSetPendingPrompt).toHaveBeenCalledWith({
      threadId: '555.000',
      payload: {
        slackTeamId: 'T123',
        slackUserId: 'U456',
        channelId: 'D789',
        threadTs: '555.000',
        nonce: 'nonce-123',
        settingsUrl: 'https://app.roomote.example/automations#suggest-ideas',
      },
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockSetPromptSentMarker).not.toHaveBeenCalled();
  });
});
