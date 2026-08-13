import type { UserAuthSuccess } from '@/types';

const {
  mockFindDeploymentSettings,
  mockGetPersistedEnvironmentVariableNames,
  mockIsChatGptSubscriptionConnected,
  mockIsGitHubCopilotSubscriptionConnected,
  mockIsXaiSubscriptionConnected,
  mockSyncConnectedXaiTaskModels,
} = vi.hoisted(() => ({
  mockFindDeploymentSettings: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn(),
  mockIsChatGptSubscriptionConnected: vi.fn(),
  mockIsGitHubCopilotSubscriptionConnected: vi.fn(),
  mockIsXaiSubscriptionConnected: vi.fn(),
  mockSyncConnectedXaiTaskModels: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: {
    query: {
      deploymentSettings: {
        findFirst: mockFindDeploymentSettings,
      },
    },
  },
  deploymentSettings: {
    id: 'id',
    taskModelSettings: 'taskModelSettings',
  },
  environmentVariables: {},
  eq: vi.fn(),
  inArray: vi.fn(),
  isChatGptSubscriptionConnected: mockIsChatGptSubscriptionConnected,
  isGitHubCopilotSubscriptionConnected:
    mockIsGitHubCopilotSubscriptionConnected,
  isXaiSubscriptionConnected: mockIsXaiSubscriptionConnected,
  isNull: vi.fn(),
}));

vi.mock('../environment-variables', () => ({
  getPersistedEnvironmentVariableNames:
    mockGetPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues: vi.fn(),
  upsertDeploymentEnvironmentVariables: vi.fn(),
}));

vi.mock('./xai-models', () => ({
  syncConnectedXaiTaskModels: mockSyncConnectedXaiTaskModels,
}));

import { getLaunchTaskModelsCommand } from './index';

function buildMockAuth(): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'user-launch-task-model-test',
    isAdmin: false,
    name: 'Launch Model Tester',
    primaryEmail: 'launch@example.com',
    resource: {
      username: 'launch-model-tester',
      fullName: 'Launch Model Tester',
      firstName: 'Launch',
      lastName: 'Model',
      primaryEmailAddress: { id: '1', emailAddress: 'launch@example.com' },
      emailAddresses: [{ id: '1', emailAddress: 'launch@example.com' }],
      imageUrl: 'https://example.com/avatar.png',
      createdAt: new Date(),
    },
  } as UserAuthSuccess;
}

describe('getLaunchTaskModelsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsChatGptSubscriptionConnected.mockResolvedValue(false);
    mockIsGitHubCopilotSubscriptionConnected.mockResolvedValue(false);
    mockIsXaiSubscriptionConnected.mockResolvedValue(true);
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    mockSyncConnectedXaiTaskModels.mockResolvedValue(0);
  });

  it('includes newly published Grok chat models without a Settings refresh', async () => {
    let persistedTaskModelSettings = {
      models: [
        {
          id: 'xai/grok-4.6',
          displayName: 'Grok 4.6',
          family: 'Grok',
        },
      ],
      allowedModelIds: ['xai/grok-4.6'],
      defaultModelId: 'xai/grok-4.6',
    };

    mockFindDeploymentSettings.mockImplementation(async () => ({
      taskModelSettings: persistedTaskModelSettings,
    }));
    mockSyncConnectedXaiTaskModels.mockImplementation(async () => {
      persistedTaskModelSettings = {
        models: [
          ...persistedTaskModelSettings.models,
          {
            id: 'xai/grok-4.7',
            displayName: 'Grok 4.7',
            family: 'Grok',
          },
        ],
        allowedModelIds: [
          ...persistedTaskModelSettings.allowedModelIds,
          'xai/grok-4.7',
        ],
        defaultModelId: persistedTaskModelSettings.defaultModelId,
      };
      return 1;
    });

    const result = await getLaunchTaskModelsCommand(buildMockAuth());

    expect(mockSyncConnectedXaiTaskModels).toHaveBeenCalledOnce();
    expect(result.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'xai/grok-4.6' }),
        expect.objectContaining({ id: 'xai/grok-4.7' }),
      ]),
    );
  });
});
