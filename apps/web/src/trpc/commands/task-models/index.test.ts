import type { FeatureFlag } from '@roomote/feature-flags';
import { normalizeTaskModelId } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

const {
  mockFindDeploymentSettings,
  mockInsertDeploymentSettings,
  mockUpdateDeploymentSettings,
  mockDbSelect,
  mockDbTransaction,
  mockTxDelete,
  mockGetPersistedEnvironmentVariableNames,
  mockGetPersistedEnvironmentVariableValues,
  mockUpsertDeploymentEnvironmentVariables,
  mockIsChatGptSubscriptionConnected,
  mockIsGitHubCopilotSubscriptionConnected,
} = vi.hoisted(() => ({
  mockFindDeploymentSettings: vi.fn(),
  mockInsertDeploymentSettings: vi.fn(),
  mockUpdateDeploymentSettings: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockTxDelete: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn(),
  mockGetPersistedEnvironmentVariableValues: vi.fn(),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
  mockIsChatGptSubscriptionConnected: vi.fn(),
  mockIsGitHubCopilotSubscriptionConnected: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ and: args })),
  db: {
    query: {
      deploymentSettings: {
        findFirst: mockFindDeploymentSettings,
      },
    },
    insert: mockInsertDeploymentSettings,
    select: mockDbSelect,
    transaction: mockDbTransaction,
  },
  deploymentSettings: {
    id: 'id',
    setupNewState: 'setupNewState',
    taskModelSettings: 'taskModelSettings',
    runtimeModelConfig: 'runtimeModelConfig',
  },
  environmentVariables: {
    name: 'env.name',
    userId: 'env.user_id',
  },
  eq: vi.fn(),
  inArray: vi.fn((column, values) => ({ column, values })),
  isChatGptSubscriptionConnected: mockIsChatGptSubscriptionConnected,
  isGitHubCopilotSubscriptionConnected:
    mockIsGitHubCopilotSubscriptionConnected,
  isNull: vi.fn((column) => ({ isNull: column })),
}));

vi.mock('../environment-variables', () => ({
  getPersistedEnvironmentVariableNames:
    mockGetPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues:
    mockGetPersistedEnvironmentVariableValues,
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
}));

import {
  getTaskModelProviderSetupCommand,
  getTaskModelSettingsCommand,
  deleteTaskModelProviderCommand,
  discoverProviderModelsCommand,
  getRecommendedLocalProviderModels,
  lookupTaskModelCommand,
  qualifyProviderModelCommand,
  refreshTaskModelMetadataCommand,
  saveTaskModelProviderCommand,
  updateTaskModelSettingsCommand,
} from './index';

const PROVIDER_ENV_VAR_NAMES = [
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'OPENCODE_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'GEMINI_API_KEY',
  'OLLAMA_BASE_URL',
  'VLLM_BASE_URL',
  'R_MODEL',
] as const;

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'user-task-model-test',
    isAdmin: true,
    name: 'Task Model Tester',
    primaryEmail: 'models@example.com',
    featureFlags: {} as Record<FeatureFlag, boolean>,
    resource: {
      username: 'task-model-tester',
      fullName: 'Task Model Tester',
      firstName: 'Task',
      lastName: 'Model',
      primaryEmailAddress: { id: '1', emailAddress: 'models@example.com' },
      emailAddresses: [{ id: '1', emailAddress: 'models@example.com' }],
      imageUrl: 'https://example.com/avatar.png',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;
}

describe('getRecommendedLocalProviderModels', () => {
  it('prefers capable coding models and excludes tiny or specialized models', () => {
    const recommended = getRecommendedLocalProviderModels([
      {
        modelId: 'ollama/tinyllama:1.1b',
        displayName: 'tinyllama:1.1b',
        family: null,
        metadata: null,
      },
      {
        modelId: 'ollama/nomic-embed-text',
        displayName: 'nomic-embed-text',
        family: null,
        metadata: null,
      },
      {
        modelId: 'ollama/llama3.3:70b',
        displayName: 'llama3.3:70b',
        family: null,
        metadata: null,
      },
      {
        modelId: 'ollama/qwen3-coder:30b',
        displayName: 'qwen3-coder:30b',
        family: null,
        metadata: null,
      },
    ]);

    expect(recommended.map((model) => model.modelId)).toEqual([
      'ollama/qwen3-coder:30b',
      'ollama/llama3.3:70b',
    ]);
  });

  it('does not automatically choose unknown local model aliases', () => {
    expect(
      getRecommendedLocalProviderModels([
        {
          modelId: 'litellm/team-default',
          displayName: 'team-default',
          family: null,
          metadata: null,
        },
      ]),
    ).toEqual([]);
  });
});

describe('lookupTaskModelCommand', () => {
  // Settings reads now depend on which provider env keys are configured
  // (recommended models of connected providers join the catalog), so clear
  // them all per test to keep results machine-independent.
  const originalProviderEnvValues = new Map<string, string | undefined>();
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalRoomoteModel = process.env.R_MODEL;
  const originalRoomoteSmallModel = process.env.R_SMALL_MODEL;
  const originalRoomoteVisionModel = process.env.R_VISION_MODEL;
  const originalRoomoteCodeReviewModel = process.env.R_CODE_REVIEW_MODEL;
  const originalRoomoteExploreModel = process.env.R_EXPLORE_MODEL;
  const originalRoomotePlanningModel = process.env.R_PLANNING_MODEL;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    for (const name of PROVIDER_ENV_VAR_NAMES) {
      originalProviderEnvValues.set(name, process.env[name]);
      delete process.env[name];
    }
    delete process.env.R_MODEL;
    delete process.env.R_SMALL_MODEL;
    delete process.env.R_VISION_MODEL;
    delete process.env.R_CODE_REVIEW_MODEL;
    delete process.env.R_EXPLORE_MODEL;
    delete process.env.R_PLANNING_MODEL;
    delete process.env.R_MODEL_REASONING_EFFORT;
    delete process.env.R_SMALL_MODEL_REASONING_EFFORT;
    delete process.env.R_VISION_MODEL_REASONING_EFFORT;
    delete process.env.R_CODE_REVIEW_MODEL_REASONING_EFFORT;
    delete process.env.R_EXPLORE_MODEL_REASONING_EFFORT;
    delete process.env.R_PLANNING_MODEL_REASONING_EFFORT;
    mockIsChatGptSubscriptionConnected.mockResolvedValue(false);
    mockIsGitHubCopilotSubscriptionConnected.mockResolvedValue(false);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({});
    mockFindDeploymentSettings.mockImplementation(async (options) => {
      const columns = (options as { columns?: Record<string, boolean> })
        ?.columns;
      const row: Record<string, unknown> = {
        taskModelSettings: null,
        runtimeModelConfig: null,
      };
      if (columns && !columns.taskModelSettings) {
        delete row.taskModelSettings;
      }
      if (columns && !columns.runtimeModelConfig) {
        delete row.runtimeModelConfig;
      }
      return row;
    });
    mockUpdateDeploymentSettings.mockImplementation(async ({ set }) => {
      mockFindDeploymentSettings.mockResolvedValue({
        taskModelSettings: set.taskModelSettings ?? null,
        runtimeModelConfig: set.runtimeModelConfig ?? null,
      });
    });
    mockInsertDeploymentSettings.mockReturnValue({
      values: vi.fn(() => ({
        onConflictDoUpdate: mockUpdateDeploymentSettings,
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    for (const name of PROVIDER_ENV_VAR_NAMES) {
      const originalValue = originalProviderEnvValues.get(name);

      if (originalValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalValue;
      }
    }

    if (originalOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    }

    if (originalRoomoteModel === undefined) {
      delete process.env.R_MODEL;
    } else {
      process.env.R_MODEL = originalRoomoteModel;
    }

    if (originalRoomoteSmallModel === undefined) {
      delete process.env.R_SMALL_MODEL;
    } else {
      process.env.R_SMALL_MODEL = originalRoomoteSmallModel;
    }

    if (originalRoomoteVisionModel === undefined) {
      delete process.env.R_VISION_MODEL;
    } else {
      process.env.R_VISION_MODEL = originalRoomoteVisionModel;
    }

    if (originalRoomoteCodeReviewModel === undefined) {
      delete process.env.R_CODE_REVIEW_MODEL;
    } else {
      process.env.R_CODE_REVIEW_MODEL = originalRoomoteCodeReviewModel;
    }

    if (originalRoomoteExploreModel === undefined) {
      delete process.env.R_EXPLORE_MODEL;
    } else {
      process.env.R_EXPLORE_MODEL = originalRoomoteExploreModel;
    }

    if (originalRoomotePlanningModel === undefined) {
      delete process.env.R_PLANNING_MODEL;
    } else {
      process.env.R_PLANNING_MODEL = originalRoomotePlanningModel;
    }

    delete process.env.R_MODEL_REASONING_EFFORT;
    delete process.env.R_SMALL_MODEL_REASONING_EFFORT;
    delete process.env.R_VISION_MODEL_REASONING_EFFORT;
    delete process.env.R_CODE_REVIEW_MODEL_REASONING_EFFORT;
    delete process.env.R_EXPLORE_MODEL_REASONING_EFFORT;
    delete process.env.R_PLANNING_MODEL_REASONING_EFFORT;
  });

  it('returns the built-in model metadata without calling OpenRouter', async () => {
    delete process.env.OPENROUTER_API_KEY;

    await expect(
      lookupTaskModelCommand(buildMockAuth(), {
        modelId: 'openrouter/openai/gpt-5.6-terra',
      }),
    ).resolves.toEqual({
      modelId: 'openrouter/openai/gpt-5.6-terra',
      displayName: 'GPT 5.6 Terra',
      family: 'GPT',
      metadata: null,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers Ollama models from /api/tags and prefixes their IDs', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      discoverProviderModelsCommand(buildMockAuth(), {
        provider: 'ollama',
        baseUrl: 'http://ollama.example',
      }),
    ).resolves.toMatchObject({
      error: null,
      modelCount: 1,
      recommendedModels: [{ modelId: 'ollama/qwen3:8b' }],
      models: [
        {
          modelId: 'ollama/qwen3:8b',
          displayName: 'qwen3:8b',
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.example/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('falls back to the OpenAI models endpoint when Ollama tags are unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'llama3.3' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );

    await expect(
      discoverProviderModelsCommand(buildMockAuth(), {
        provider: 'ollama',
        baseUrl: 'http://ollama.example/v1',
      }),
    ).resolves.toMatchObject({
      error: null,
      models: [{ modelId: 'ollama/llama3.3' }],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://ollama.example/v1/models',
      expect.anything(),
    );
  });

  it('uses saved LiteLLM credentials and metadata when discovering models', async () => {
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
      LITELLM_BASE_URL: 'https://litellm.example/v1',
      LITELLM_API_KEY: 'saved-key',
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'azure/gpt-4o' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'azure/gpt-4o',
                model_info: { max_input_tokens: 128_000 },
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(
      discoverProviderModelsCommand(buildMockAuth(), { provider: 'litellm' }),
    ).resolves.toMatchObject({
      models: [
        {
          modelId: 'litellm/azure/gpt-4o',
          metadata: expect.objectContaining({ contextWindow: 128_000 }),
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://litellm.example/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer saved-key' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://litellm.example/model/info',
      expect.objectContaining({
        headers: { Authorization: 'Bearer saved-key' },
      }),
    );
  });

  it('qualifies a provider model with a streaming tool request', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"ping"}}]}}]}\n\n',
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );

    await expect(
      qualifyProviderModelCommand(buildMockAuth(), {
        provider: 'vllm',
        baseUrl: 'https://vllm.example/v1',
        apiKey: 'submitted-key',
        modelId: 'vllm/qwen3',
      }),
    ).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vllm.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer submitted-key',
        }),
        body: expect.stringContaining('"stream":true'),
      }),
    );
  });

  it('rejects streams that do not call the qualification tool', async () => {
    fetchMock.mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    await expect(
      qualifyProviderModelCommand(buildMockAuth(), {
        provider: 'ollama',
        baseUrl: 'http://ollama.example',
        modelId: 'ollama/qwen3',
      }),
    ).resolves.toEqual({
      success: false,
      error: expect.stringContaining('did not call the required tool'),
    });
  });

  it('returns provider compatibility details from qualification errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: 'tools are unsupported for this model' }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      qualifyProviderModelCommand(buildMockAuth(), {
        provider: 'vllm',
        baseUrl: 'https://vllm.example',
        modelId: 'vllm/qwen3',
      }),
    ).resolves.toEqual({
      success: false,
      error: expect.stringContaining('tools are unsupported for this model'),
    });
  });

  it('uses discovery data when looking up a local provider model', async () => {
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
      VLLM_BASE_URL: 'https://vllm.example/v1',
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'llama3.3' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      lookupTaskModelCommand(buildMockAuth(), {
        modelId: 'vllm/llama3.3',
      }),
    ).resolves.toMatchObject({ modelId: 'vllm/llama3.3' });
  });

  it.each(['google-vertex/gemini-3.5-flash', 'mistral/mistral-large-latest'])(
    'rejects disabled direct-provider model id %s',
    async (modelId) => {
      await expect(
        lookupTaskModelCommand(buildMockAuth(), {
          modelId,
        }),
      ).rejects.toThrow('This direct model provider is currently disabled.');

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('normalizes bare author/model input and uses OpenRouter lookup when available', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: 'z-ai/glm-5.3',
            name: 'GLM 5.3',
            context_length: 1_050_000,
            architecture: {
              input_modalities: ['text', 'image'],
            },
            pricing: {
              prompt: '0.000002',
              completion: '0.00001',
            },
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      lookupTaskModelCommand(buildMockAuth(), {
        modelId: 'z-ai/glm-5.3',
      }),
    ).resolves.toEqual({
      modelId: 'openrouter/z-ai/glm-5.3',
      displayName: 'GLM 5.3',
      family: 'GLM',
      metadata: {
        contextWindow: 1_050_000,
        inputTypes: ['text', 'image'],
        inputPricePerToken: 0.000002,
        outputPricePerToken: 0.00001,
        lastRefreshedAt: expect.any(String),
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/model/z-ai/glm-5.3',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer openrouter-test-key',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('extracts reasoning support from the OpenRouter supported_parameters list', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: 'openai/gpt-5.6',
            name: 'GPT 5.6',
            context_length: 400_000,
            supported_parameters: ['temperature', 'reasoning'],
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      lookupTaskModelCommand(buildMockAuth(), {
        modelId: 'z-ai/glm-reasoner',
      }),
    ).resolves.toMatchObject({
      metadata: expect.objectContaining({ supportsReasoning: true }),
    });
  });

  it('resolves direct-provider models from the models.dev catalog', async () => {
    delete process.env.OPENROUTER_API_KEY;
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          models: {
            'anthropic/claude-sonnet-4': {
              id: 'anthropic/claude-sonnet-4',
              name: 'Claude Sonnet 4',
              modalities: { input: ['text', 'image'] },
              limit: { context: 200_000 },
            },
          },
          providers: {
            anthropic: {
              models: {
                'claude-sonnet-4': {
                  id: 'claude-sonnet-4',
                  cost: { input: 3, output: 15 },
                },
              },
            },
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      lookupTaskModelCommand(buildMockAuth(), {
        modelId: 'anthropic/claude-sonnet-4',
      }),
    ).resolves.toEqual({
      modelId: 'anthropic/claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      family: 'Claude',
      metadata: {
        contextWindow: 200_000,
        inputTypes: ['text', 'image'],
        inputPricePerToken: 0.000003,
        outputPricePerToken: 0.000015,
        lastRefreshedAt: expect.any(String),
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.dev/catalog.json',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('uses a timeout signal when refreshing models.dev metadata', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          providers: {
            openrouter: {
              models: {
                'z-ai/glm-5.2': {
                  id: 'z-ai/glm-5.2',
                  name: 'GLM 5.2',
                  modalities: { input: ['text'] },
                  limit: { context: 1_048_576 },
                  cost: { input: 0.93, output: 3 },
                },
              },
            },
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await refreshTaskModelMetadataCommand(buildMockAuth());

    expect(result).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.dev/catalog.json',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('accepts shorthand default model IDs when they normalize to an enabled model', async () => {
    const auth = buildMockAuth();
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'OPENROUTER_API_KEY',
    ]);

    const result = await updateTaskModelSettingsCommand(auth, {
      models: [
        {
          id: 'z-ai/glm-5.6',
          displayName: 'GLM 5.6',
          family: 'GLM',
        },
      ],
      allowedModelIds: ['z-ai/glm-5.6'],
      defaultModelId: 'z-ai/glm-5.6',
      helperModelId: null,
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: null,
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    if (!result.success) {
      throw new Error('Expected the model settings update to succeed.');
    }

    expect(result).toMatchObject({
      success: true,
      settings: {
        defaultModelId: 'openrouter/z-ai/glm-5.6',
        runtimeModels: {
          codingModel: {
            effectiveModelId: 'openrouter/z-ai/glm-5.6',
            persistedModelId: 'openrouter/z-ai/glm-5.6',
            source: 'database',
          },
        },
      },
    });
    expect(result.settings.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openrouter/z-ai/glm-5.6',
          enabled: true,
          isDefault: true,
        }),
      ]),
    );

    expect(mockInsertDeploymentSettings).toHaveBeenCalled();
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          taskModelSettings: expect.objectContaining({
            allowedModelIds: [normalizeTaskModelId('z-ai/glm-5.6')],
            defaultModelId: normalizeTaskModelId('z-ai/glm-5.6'),
          }),
          runtimeModelConfig: expect.objectContaining({
            roomoteModel: 'openrouter/z-ai/glm-5.6',
            roomoteSmallModel: null,
            roomoteVisionModel: null,
            roomoteCodeReviewModel: null,
            roomoteExploreModel: null,
            roomotePlanningModel: null,
            roomoteModelReasoningEffort: null,
            roomoteSmallModelReasoningEffort: null,
            roomoteVisionModelReasoningEffort: null,
            roomoteCodeReviewModelReasoningEffort: null,
            roomoteExploreModelReasoningEffort: null,
            roomotePlanningModelReasoningEffort: null,
          }),
        }),
      }),
    );
  });

  it('preserves direct-provider model IDs without rewriting them to OpenRouter', async () => {
    const auth = buildMockAuth();

    const result = await updateTaskModelSettingsCommand(auth, {
      models: [
        {
          id: 'anthropic/claude-sonnet-4',
          displayName: 'Claude Sonnet 4',
          family: 'Claude',
        },
      ],
      allowedModelIds: ['anthropic/claude-sonnet-4'],
      defaultModelId: 'anthropic/claude-sonnet-4',
      helperModelId: null,
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: null,
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({
      success: true,
      settings: {
        defaultModelId: 'anthropic/claude-sonnet-4',
      },
    });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          taskModelSettings: expect.objectContaining({
            allowedModelIds: ['anthropic/claude-sonnet-4'],
            defaultModelId: 'anthropic/claude-sonnet-4',
          }),
          runtimeModelConfig: expect.objectContaining({
            roomoteModel: 'anthropic/claude-sonnet-4',
          }),
        }),
      }),
    );
  });

  it('persists a selected helper model to runtimeModelConfig.roomoteSmallModel', async () => {
    const auth = buildMockAuth();

    const result = await updateTaskModelSettingsCommand(auth, {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
        {
          id: 'z-ai/glm-5.2',
          displayName: 'GLM 5.2',
          family: 'GLM',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6', 'z-ai/glm-5.2'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: 'z-ai/glm-5.2',
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: null,
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: {
            roomoteModel: 'openrouter/openai/gpt-5.6',
            roomoteSmallModel: 'openrouter/z-ai/glm-5.2',
            roomoteVisionModel: null,
            roomoteCodeReviewModel: null,
            roomoteExploreModel: null,
            roomotePlanningModel: null,
            roomoteModelReasoningEffort: null,
            roomoteSmallModelReasoningEffort: null,
            roomoteVisionModelReasoningEffort: null,
            roomoteCodeReviewModelReasoningEffort: null,
            roomoteExploreModelReasoningEffort: null,
            roomotePlanningModelReasoningEffort: null,
          },
        }),
      }),
    );
  });

  it('persists a selected vision model to runtimeModelConfig.roomoteVisionModel', async () => {
    const auth = buildMockAuth();

    const result = await updateTaskModelSettingsCommand(auth, {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
        {
          id: 'z-ai/glm-5.2',
          displayName: 'GLM 5.2',
          family: 'GLM',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6', 'z-ai/glm-5.2'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: null,
      visionModelId: 'z-ai/glm-5.2',
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: null,
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: {
            roomoteModel: 'openrouter/openai/gpt-5.6',
            roomoteSmallModel: null,
            roomoteVisionModel: 'openrouter/z-ai/glm-5.2',
            roomoteCodeReviewModel: null,
            roomoteExploreModel: null,
            roomotePlanningModel: null,
            roomoteModelReasoningEffort: null,
            roomoteSmallModelReasoningEffort: null,
            roomoteVisionModelReasoningEffort: null,
            roomoteCodeReviewModelReasoningEffort: null,
            roomoteExploreModelReasoningEffort: null,
            roomotePlanningModelReasoningEffort: null,
          },
        }),
      }),
    );
  });

  it('does not DB-override an env-managed coding model, preserving the persisted value', async () => {
    process.env.R_MODEL = 'openrouter/z-ai/glm-5.2';
    mockFindDeploymentSettings.mockResolvedValue({
      taskModelSettings: null,
      runtimeModelConfig: {
        roomoteModel: 'openrouter/anthropic/claude-sonnet-4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: null,
        roomoteExploreModel: null,
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: null,
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: null,
      },
    });

    const result = await updateTaskModelSettingsCommand(buildMockAuth(), {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: null,
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: null,
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: {
            roomoteModel: 'openrouter/anthropic/claude-sonnet-4',
            roomoteSmallModel: null,
            roomoteVisionModel: null,
            roomoteCodeReviewModel: null,
            roomoteExploreModel: null,
            roomotePlanningModel: null,
            roomoteModelReasoningEffort: null,
            roomoteSmallModelReasoningEffort: null,
            roomoteVisionModelReasoningEffort: null,
            roomoteCodeReviewModelReasoningEffort: null,
            roomoteExploreModelReasoningEffort: null,
            roomotePlanningModelReasoningEffort: null,
          },
        }),
      }),
    );
  });

  it('does not DB-override an env-managed helper model, preserving the persisted value', async () => {
    process.env.R_SMALL_MODEL = 'openrouter/z-ai/glm-5.2';
    mockFindDeploymentSettings.mockResolvedValue({
      taskModelSettings: null,
      runtimeModelConfig: {
        roomoteModel: null,
        roomoteSmallModel: 'openrouter/anthropic/claude-haiku-4',
        roomoteVisionModel: null,
        roomoteCodeReviewModel: null,
        roomoteExploreModel: null,
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: null,
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: null,
      },
    });

    const result = await updateTaskModelSettingsCommand(buildMockAuth(), {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: 'openrouter/openai/gpt-5.6',
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: null,
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: {
            roomoteModel: 'openrouter/openai/gpt-5.6',
            roomoteSmallModel: 'openrouter/anthropic/claude-haiku-4',
            roomoteVisionModel: null,
            roomoteCodeReviewModel: null,
            roomoteExploreModel: null,
            roomotePlanningModel: null,
            roomoteModelReasoningEffort: null,
            roomoteSmallModelReasoningEffort: null,
            roomoteVisionModelReasoningEffort: null,
            roomoteCodeReviewModelReasoningEffort: null,
            roomoteExploreModelReasoningEffort: null,
            roomotePlanningModelReasoningEffort: null,
          },
        }),
      }),
    );
  });

  it('does not DB-override an env-managed vision model, preserving the persisted value', async () => {
    process.env.R_VISION_MODEL = 'openrouter/z-ai/glm-5.2';
    mockFindDeploymentSettings.mockResolvedValue({
      taskModelSettings: null,
      runtimeModelConfig: {
        roomoteModel: null,
        roomoteSmallModel: null,
        roomoteVisionModel: 'openrouter/anthropic/claude-sonnet-4',
        roomoteCodeReviewModel: null,
        roomoteExploreModel: null,
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: null,
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: null,
      },
    });

    const result = await updateTaskModelSettingsCommand(buildMockAuth(), {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: null,
      visionModelId: 'openrouter/openai/gpt-5.6',
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: null,
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: {
            roomoteModel: 'openrouter/openai/gpt-5.6',
            roomoteSmallModel: null,
            roomoteVisionModel: 'openrouter/anthropic/claude-sonnet-4',
            roomoteCodeReviewModel: null,
            roomoteExploreModel: null,
            roomotePlanningModel: null,
            roomoteModelReasoningEffort: null,
            roomoteSmallModelReasoningEffort: null,
            roomoteVisionModelReasoningEffort: null,
            roomoteCodeReviewModelReasoningEffort: null,
            roomoteExploreModelReasoningEffort: null,
            roomotePlanningModelReasoningEffort: null,
          },
        }),
      }),
    );
  });

  it('persists per-role reasoning efforts to runtimeModelConfig', async () => {
    const auth = buildMockAuth();

    const result = await updateTaskModelSettingsCommand(auth, {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: null,
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: 'high',
      helperModelReasoningEffort: 'low',
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: 'xhigh',
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({
      success: true,
      settings: {
        runtimeModels: {
          codingModel: {
            reasoningEffort: 'high',
            reasoningManagedByEnv: false,
          },
          helperModel: {
            reasoningEffort: 'low',
            reasoningManagedByEnv: false,
          },
          visionModel: {
            reasoningEffort: null,
            reasoningManagedByEnv: false,
          },
          codeReviewModel: {
            reasoningEffort: 'xhigh',
            reasoningManagedByEnv: false,
          },
          exploreModel: {
            reasoningEffort: null,
            reasoningManagedByEnv: false,
          },
        },
      },
    });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: expect.objectContaining({
            roomoteModelReasoningEffort: 'high',
            roomoteSmallModelReasoningEffort: 'low',
            roomoteVisionModelReasoningEffort: null,
            roomoteCodeReviewModelReasoningEffort: 'xhigh',
            roomoteExploreModelReasoningEffort: null,
            roomotePlanningModelReasoningEffort: null,
          }),
        }),
      }),
    );
  });

  it('persists the selected reasoning effort when the env override is invalid', async () => {
    process.env.R_MODEL_REASONING_EFFORT = 'turbo';

    const result = await updateTaskModelSettingsCommand(buildMockAuth(), {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: null,
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: 'xhigh',
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    // An invalid env value is not env-managed: the read path shows the
    // selector enabled, so the write path must honor the admin's selection.
    expect(result).toMatchObject({
      success: true,
      settings: {
        runtimeModels: {
          codingModel: {
            reasoningEffort: 'xhigh',
            reasoningManagedByEnv: false,
          },
        },
      },
    });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: expect.objectContaining({
            roomoteModelReasoningEffort: 'xhigh',
          }),
        }),
      }),
    );
  });

  it('does not DB-override an env-managed reasoning effort, preserving the persisted value', async () => {
    process.env.R_MODEL_REASONING_EFFORT = 'medium';
    mockFindDeploymentSettings.mockResolvedValue({
      taskModelSettings: null,
      runtimeModelConfig: {
        roomoteModel: null,
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: null,
        roomoteExploreModel: null,
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: 'low',
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: null,
      },
    });

    const result = await updateTaskModelSettingsCommand(buildMockAuth(), {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: null,
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: 'xhigh',
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: expect.objectContaining({
            roomoteModelReasoningEffort: 'low',
          }),
        }),
      }),
    );
  });

  it('preserves persisted explore settings when a partial save omits explore fields', async () => {
    mockFindDeploymentSettings.mockResolvedValue({
      taskModelSettings: null,
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.6',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: null,
        roomoteExploreModel: 'openrouter/anthropic/claude-haiku-4',
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: null,
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: 'low',
        roomotePlanningModelReasoningEffort: null,
      },
    });

    const result = await updateTaskModelSettingsCommand(buildMockAuth(), {
      models: [
        {
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
          family: 'GPT',
        },
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
      helperModelId: null,
      visionModelId: null,
      codeReviewModelId: null,
      planningModelId: null,
      codingModelReasoningEffort: null,
      helperModelReasoningEffort: null,
      visionModelReasoningEffort: null,
      codeReviewModelReasoningEffort: null,
      planningModelReasoningEffort: null,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockUpdateDeploymentSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          runtimeModelConfig: expect.objectContaining({
            roomoteExploreModel: 'openrouter/anthropic/claude-haiku-4',
            roomoteExploreModelReasoningEffort: 'low',
          }),
        }),
      }),
    );
  });
});

describe('task model provider commands', () => {
  const originalEnvValues = new Map<string, string | undefined>();
  const txOnConflictDoUpdate = vi.fn();
  const txValues = vi.fn(() => ({
    onConflictDoUpdate: txOnConflictDoUpdate,
  }));
  const txInsert = vi.fn(() => ({ values: txValues }));
  const txDeleteWhere = vi.fn(async () => undefined);

  function buildSelectChainMock(rows: unknown[]) {
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    };
  }

  function mockPersistedSetupNewState(
    setupNewState: unknown,
    taskModelSettings: unknown = null,
  ) {
    const selectImplementation = () =>
      buildSelectChainMock([{ setupNewState, taskModelSettings }]);

    mockDbSelect.mockImplementation(selectImplementation);
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: vi.fn(selectImplementation),
          insert: txInsert,
          delete: mockTxDelete,
        }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTxDelete.mockReturnValue({ where: txDeleteWhere });

    for (const name of PROVIDER_ENV_VAR_NAMES) {
      originalEnvValues.set(name, process.env[name]);
      delete process.env[name];
    }

    mockFindDeploymentSettings.mockResolvedValue({
      taskModelSettings: null,
      runtimeModelConfig: null,
    });
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({});
    mockIsChatGptSubscriptionConnected.mockResolvedValue(false);
    mockIsGitHubCopilotSubscriptionConnected.mockResolvedValue(false);
    mockPersistedSetupNewState({});
  });

  afterEach(() => {
    for (const name of PROVIDER_ENV_VAR_NAMES) {
      const originalValue = originalEnvValues.get(name);

      if (originalValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalValue;
      }
    }
  });

  it('appends recommended models of connected providers to the settings catalog, disabled', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'ANTHROPIC_API_KEY',
    ]);

    const result = await getTaskModelSettingsCommand(buildMockAuth());
    const anthropicModels = result.models.filter((model) =>
      model.id.startsWith('anthropic/'),
    );

    // Anthropic is connected but has no persisted models: its full static
    // recommended list joins the catalog as disabled, metadata-less rows.
    expect(anthropicModels.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        'anthropic/claude-sonnet-5',
        'anthropic/claude-opus-4-8',
        'anthropic/claude-haiku-4-5',
      ]),
    );
    expect(
      anthropicModels.every(
        (model) => !model.enabled && model.metadata === null,
      ),
    ).toBe(true);
    // Unconnected providers contribute nothing.
    expect(result.models.some((model) => model.id.startsWith('google/'))).toBe(
      false,
    );
  });

  it('hides persisted OpenRouter models when only vLLM is connected', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'VLLM_BASE_URL',
    ]);
    mockFindDeploymentSettings.mockResolvedValue({
      taskModelSettings: {
        models: [
          {
            id: 'openrouter/openai/gpt-5.6-terra',
            displayName: 'GPT 5.6 Terra',
            family: 'GPT',
          },
          {
            id: 'vllm/qwen3:8b',
            displayName: 'Qwen 3 8B',
            family: 'Qwen',
          },
        ],
        allowedModelIds: ['openrouter/openai/gpt-5.6-terra', 'vllm/qwen3:8b'],
        defaultModelId: 'openrouter/openai/gpt-5.6-terra',
      },
      runtimeModelConfig: null,
    });

    const result = await getTaskModelSettingsCommand(buildMockAuth());

    expect(result.models.map((model) => model.id)).toEqual(['vllm/qwen3:8b']);
  });

  it('preselects the saved provider choice and reports saved API keys', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'ANTHROPIC_API_KEY',
    ]);
    mockPersistedSetupNewState({ modelProvider: 'anthropic' });

    const result = await getTaskModelProviderSetupCommand(buildMockAuth());

    expect(result.providerSetup.preselectedProvider).toBe('anthropic');
    expect(
      result.providerSetup.providers.find(
        (provider) => provider.id === 'anthropic',
      ),
    ).toMatchObject({
      runtimeApiKeySatisfied: false,
      savedApiKeySatisfied: true,
    });
  });

  it('returns saved non-secret additional provider values', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_REGION',
      'LITELLM_BASE_URL',
      'OLLAMA_BASE_URL',
      'VLLM_BASE_URL',
    ]);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
      AWS_REGION: 'us-west-2',
    });

    const result = await getTaskModelProviderSetupCommand(buildMockAuth());

    expect(mockGetPersistedEnvironmentVariableValues).toHaveBeenCalledWith([
      'AWS_REGION',
      'LITELLM_BASE_URL',
      'OLLAMA_BASE_URL',
      'VLLM_BASE_URL',
    ]);
    expect(
      result.providerSetup.providers.find(
        (provider) => provider.id === 'amazon-bedrock',
      ),
    ).toMatchObject({
      savedApiKeySatisfied: true,
      additionalEnvValues: { AWS_REGION: 'us-west-2' },
    });
  });

  it('rejects saving a provider that has no API key anywhere', async () => {
    await expect(
      saveTaskModelProviderCommand(buildMockAuth(), {
        provider: 'anthropic',
      }),
    ).rejects.toThrow('Enter your Anthropic API key to save it.');

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('saves the API key and seeds the recommended models for a newly connected provider', async () => {
    mockGetPersistedEnvironmentVariableNames
      .mockResolvedValueOnce([])
      .mockResolvedValue(['ANTHROPIC_API_KEY']);

    const result = await saveTaskModelProviderCommand(buildMockAuth(), {
      provider: 'anthropic',
      apiKey: '  sk-ant-test  ',
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: 'user-task-model-test',
        values: [
          {
            name: 'ANTHROPIC_API_KEY',
            value: 'sk-ant-test',
          },
        ],
      },
    );

    expect(txOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          setupNewState: expect.objectContaining({
            modelProvider: 'anthropic',
            lastInteractedByUserId: 'user-task-model-test',
          }),
        }),
      }),
    );

    const updateSet = txOnConflictDoUpdate.mock.calls[0]?.[0]?.set;
    expect(updateSet).not.toHaveProperty('runtimeModelConfig');

    // The deployment had no models for Anthropic, so its recommended models
    // from the centralized list are seeded and enabled, and the default
    // model switches to the provider default since no other connected
    // provider backed the previous effective default.
    const seededSettings = updateSet?.taskModelSettings;
    expect(
      seededSettings?.models.map((model: { id: string }) => model.id),
    ).toEqual([
      'anthropic/claude-fable-5',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-sonnet-5',
    ]);
    expect([...seededSettings.allowedModelIds].sort()).toEqual([
      'anthropic/claude-fable-5',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-sonnet-5',
    ]);
    expect(seededSettings?.defaultModelId).toBe('anthropic/claude-sonnet-5');
    expect(result.addedRecommendedModelCount).toBe(4);

    expect(
      result.providerSetup.providers.find(
        (provider) => provider.id === 'anthropic',
      ),
    ).toMatchObject({ savedApiKeySatisfied: true });
  });

  it('keeps other connected providers models when seeding a fresh deployment', async () => {
    process.env.OPENROUTER_API_KEY = 'runtime-openrouter-key';
    mockGetPersistedEnvironmentVariableNames
      .mockResolvedValueOnce([])
      .mockResolvedValue(['ANTHROPIC_API_KEY']);

    const result = await saveTaskModelProviderCommand(buildMockAuth(), {
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    const seededSettings =
      txOnConflictDoUpdate.mock.calls[0]?.[0]?.set?.taskModelSettings;
    const modelIds = seededSettings?.models.map(
      (model: { id: string }) => model.id,
    );

    // The default catalog's OpenRouter models stay (that provider is
    // connected via runtime env) and keep the effective default model.
    expect(modelIds).toContain('openrouter/openai/gpt-5.6-terra');
    expect(modelIds).toContain('anthropic/claude-sonnet-5');
    expect(seededSettings?.defaultModelId).toBe(
      'openrouter/openai/gpt-5.6-terra',
    );
    expect(result.addedRecommendedModelCount).toBe(4);
  });

  it('does not reseed models when the provider already has configured models', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    mockPersistedSetupNewState(
      {},
      {
        models: [
          {
            id: 'anthropic/claude-sonnet-5',
            displayName: 'Claude Sonnet 5',
            family: 'Sonnet',
          },
        ],
        allowedModelIds: ['anthropic/claude-sonnet-5'],
        defaultModelId: 'anthropic/claude-sonnet-5',
      },
    );

    const result = await saveTaskModelProviderCommand(buildMockAuth(), {
      provider: 'anthropic',
      apiKey: 'sk-ant-rotated',
    });

    expect(result.addedRecommendedModelCount).toBe(0);
    expect(txOnConflictDoUpdate.mock.calls[0]?.[0]?.set).not.toHaveProperty(
      'taskModelSettings',
    );
  });

  it('allows re-saving a provider without a key when one is already saved', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'OPENROUTER_API_KEY',
    ]);

    await expect(
      saveTaskModelProviderCommand(buildMockAuth(), {
        provider: 'openrouter',
      }),
    ).resolves.toMatchObject({
      providerSetup: expect.objectContaining({
        preselectedProvider: 'openrouter',
      }),
    });

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    expect(txOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          setupNewState: expect.objectContaining({
            modelProvider: 'openrouter',
          }),
        }),
      }),
    );
    // The implicit default catalog already covers OpenRouter, so nothing is
    // reseeded.
    expect(txOnConflictDoUpdate.mock.calls[0]?.[0]?.set).not.toHaveProperty(
      'taskModelSettings',
    );
  });

  it('rejects saving the ChatGPT subscription provider with an API key', async () => {
    await expect(
      saveTaskModelProviderCommand(buildMockAuth(), {
        provider: 'chatgpt',
        apiKey: 'not-an-api-key',
      }),
    ).rejects.toThrow(/ChatGPT/);
  });

  it('saves multi-credential providers with their additional env values', async () => {
    mockGetPersistedEnvironmentVariableNames
      .mockResolvedValueOnce([])
      .mockResolvedValue(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);

    await saveTaskModelProviderCommand(buildMockAuth(), {
      provider: 'amazon-bedrock',
      apiKey: ' bedrock-key ',
      additionalEnvValues: { AWS_REGION: ' us-west-2 ' },
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: 'user-task-model-test',
        values: [
          { name: 'AWS_BEARER_TOKEN_BEDROCK', value: 'bedrock-key' },
          { name: 'AWS_REGION', value: 'us-west-2' },
        ],
      },
    );
    expect(txOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          setupNewState: expect.objectContaining({
            modelProvider: 'amazon-bedrock',
          }),
        }),
      }),
    );
  });

  it('rejects additional env values the provider does not declare', async () => {
    await expect(
      saveTaskModelProviderCommand(buildMockAuth(), {
        provider: 'amazon-bedrock',
        apiKey: 'bedrock-key',
        additionalEnvValues: { DATABASE_URL: 'nope' },
      }),
    ).rejects.toThrow('Amazon Bedrock does not accept a DATABASE_URL value.');

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it('clears a previously saved optional field submitted as blank', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_REGION',
    ]);

    await saveTaskModelProviderCommand(buildMockAuth(), {
      provider: 'amazon-bedrock',
      additionalEnvValues: { AWS_REGION: '' },
    });

    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    expect(mockTxDelete).toHaveBeenCalled();
    expect(txDeleteWhere).toHaveBeenCalledWith({
      and: [
        { isNull: 'env.user_id' },
        { column: 'env.name', values: ['AWS_REGION'] },
      ],
    });
  });

  it('does not delete anything when a blanked optional field was never saved', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'AWS_BEARER_TOKEN_BEDROCK',
    ]);

    await saveTaskModelProviderCommand(buildMockAuth(), {
      provider: 'amazon-bedrock',
      additionalEnvValues: { AWS_REGION: '' },
    });

    expect(mockTxDelete).not.toHaveBeenCalled();
  });

  it('allows removing the last API-key provider when ChatGPT remains connected', async () => {
    // The connected ChatGPT subscription is counted exactly once by the
    // last-provider guard, so removing the only saved API-key provider is
    // allowed because the subscription keeps the deployment usable.
    mockIsChatGptSubscriptionConnected.mockResolvedValue(true);
    mockIsGitHubCopilotSubscriptionConnected.mockResolvedValue(false);
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'ANTHROPIC_API_KEY',
    ]);

    await deleteTaskModelProviderCommand(buildMockAuth(), {
      provider: 'anthropic',
    });

    expect(mockTxDelete).toHaveBeenCalled();
  });

  it('rejects deleting the last connected provider', async () => {
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'ANTHROPIC_API_KEY',
    ]);

    await expect(
      deleteTaskModelProviderCommand(buildMockAuth(), {
        provider: 'anthropic',
      }),
    ).rejects.toThrow('Keep at least one inference provider connected.');

    expect(mockTxDelete).not.toHaveBeenCalled();
    expect(txOnConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('deletes provider credentials and cascades removing provider models without deleting usage data', async () => {
    const persistedRow = {
      taskModelSettings: {
        models: [
          {
            id: 'anthropic/claude-sonnet-4',
            displayName: 'Claude Sonnet 4',
            family: 'Claude',
          },
          {
            id: 'openrouter/openai/gpt-5.6-terra',
            displayName: 'GPT 5.4',
            family: 'GPT',
          },
        ],
        allowedModelIds: [
          'anthropic/claude-sonnet-4',
          'openrouter/openai/gpt-5.6-terra',
        ],
        defaultModelId: 'anthropic/claude-sonnet-4',
      },
      runtimeModelConfig: {
        roomoteModel: 'anthropic/claude-sonnet-4',
        roomoteSmallModel: 'anthropic/claude-sonnet-4',
        roomoteVisionModel: 'openrouter/openai/gpt-5.6-terra',
        roomoteCodeReviewModel: null,
        roomoteExploreModel: null,
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: null,
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: null,
      },
    };
    mockFindDeploymentSettings.mockImplementation(async (options) => {
      const columns = (options as { columns?: Record<string, boolean> })
        ?.columns;
      return {
        ...(columns?.taskModelSettings
          ? { taskModelSettings: persistedRow.taskModelSettings }
          : {}),
        ...(columns?.runtimeModelConfig
          ? { runtimeModelConfig: persistedRow.runtimeModelConfig }
          : {}),
      };
    });
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
    ]);
    mockPersistedSetupNewState({ modelProvider: 'anthropic' });

    await deleteTaskModelProviderCommand(buildMockAuth(), {
      provider: 'anthropic',
    });

    const { inArray, isNull } = await import('@roomote/db/server');
    expect(mockTxDelete).toHaveBeenCalled();
    expect(inArray).toHaveBeenCalledWith('env.name', ['ANTHROPIC_API_KEY']);
    expect(isNull).toHaveBeenCalledWith('env.user_id');

    const updateSet = txOnConflictDoUpdate.mock.calls[0]?.[0]?.set;
    expect(updateSet.taskModelSettings.models).toEqual([
      expect.objectContaining({ id: 'openrouter/openai/gpt-5.6-terra' }),
    ]);
    expect(updateSet.taskModelSettings.allowedModelIds).toEqual([
      'openrouter/openai/gpt-5.6-terra',
    ]);
    expect(updateSet.taskModelSettings.defaultModelId).toBe(
      'openrouter/openai/gpt-5.6-terra',
    );
    expect(updateSet.runtimeModelConfig.roomoteModel).toBeNull();
    expect(updateSet.runtimeModelConfig.roomoteSmallModel).toBeNull();
    expect(updateSet.runtimeModelConfig.roomoteVisionModel).toBe(
      'openrouter/openai/gpt-5.6-terra',
    );
    expect(updateSet.setupNewState.modelProvider).toBeNull();
  });
});
