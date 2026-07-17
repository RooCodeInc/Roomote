const {
  mockDecryptSecrets,
  mockDeploymentSettingsFindFirst,
  mockEnvironmentVariablesFindMany,
  mockResolveOpenCodeAuthContent,
} = vi.hoisted(() => ({
  mockDecryptSecrets: vi.fn(),
  mockDeploymentSettingsFindFirst: vi.fn(),
  mockEnvironmentVariablesFindMany: vi.fn(),
  mockResolveOpenCodeAuthContent: vi.fn(),
}));

vi.mock('../encryption', () => ({
  decryptSecrets: (...args: unknown[]) => mockDecryptSecrets(...args),
}));

vi.mock('../db', () => ({
  db: {
    query: {
      deploymentSettings: {
        findFirst: (...args: unknown[]) =>
          mockDeploymentSettingsFindFirst(...args),
      },
      environmentVariables: {
        findMany: (...args: unknown[]) =>
          mockEnvironmentVariablesFindMany(...args),
      },
    },
  },
}));

vi.mock('./environment-variables', () => ({
  stringifyDecryptedEnvVarValue: (value: unknown) => String(value),
}));

vi.mock('./chatgpt-subscription', () => ({
  resolveOpenCodeAuthContent: (...args: unknown[]) =>
    mockResolveOpenCodeAuthContent(...args),
}));

vi.mock('../schema', () => ({
  deploymentSettings: { id: 'deploymentSettings.id' },
  eq: vi.fn(),
}));

import { resolveEffectiveModelRuntimeEnv } from './model-runtime-config';

describe('resolveEffectiveModelRuntimeEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptSecrets.mockImplementation(async (value) => value);
    mockEnvironmentVariablesFindMany.mockResolvedValue([]);
    mockResolveOpenCodeAuthContent.mockResolvedValue(null);
  });

  it('prefers real runtime env values over persisted deployment config', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'anthropic/claude-sonnet-4',
        roomoteVisionModel: 'anthropic/claude-opus-4.7',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {
        R_MODEL: 'openai/gpt-5.4',
        R_VISION_MODEL: 'openai/gpt-5.5',
        OPENAI_API_KEY: 'sk-runtime',
      },
      deploymentEnvVars: {
        OPENAI_API_KEY: 'sk-saved',
        ANTHROPIC_API_KEY: 'sk-anthropic',
      },
    });

    expect(env).toEqual({
      R_MODEL: 'openai/gpt-5.4',
      R_VISION_MODEL: 'openai/gpt-5.5',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_VISION_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'OPENAI_API_KEY',
      OPENAI_API_KEY: 'sk-runtime',
    });
  });

  it('falls back to persisted model config and saved encrypted env vars', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'anthropic/claude-sonnet-4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
      },
    });
    mockEnvironmentVariablesFindMany.mockResolvedValue([
      {
        name: 'ANTHROPIC_API_KEY',
        value: 'sk-encrypted',
      },
    ]);
    mockDecryptSecrets.mockResolvedValue('sk-persisted');

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
    });

    expect(mockEnvironmentVariablesFindMany).toHaveBeenCalledTimes(1);
    expect(env).toEqual({
      R_MODEL: 'anthropic/claude-sonnet-4',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'ANTHROPIC_API_KEY',
      ANTHROPIC_API_KEY: 'sk-persisted',
    });
  });

  it('falls back to persisted roomoteSmallModel when the env var is absent', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: 'openrouter/z-ai/glm-5.2',
        roomoteVisionModel: null,
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).toEqual({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_SMALL_MODEL: 'openrouter/z-ai/glm-5.2',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'OPENROUTER_API_KEY',
      OPENROUTER_API_KEY: 'sk-openrouter',
    });
  });

  it('prefers the R_SMALL_MODEL env var over the persisted small model', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: 'openrouter/z-ai/glm-5.2',
        roomoteVisionModel: null,
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {
        R_SMALL_MODEL: 'openrouter/anthropic/claude-sonnet-4',
        OPENROUTER_API_KEY: 'sk-runtime',
      },
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-saved',
      },
    });

    expect(env).toMatchObject({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_SMALL_MODEL: 'openrouter/anthropic/claude-sonnet-4',
      OPENROUTER_API_KEY: 'sk-runtime',
    });
  });

  it('omits R_SMALL_MODEL when neither env nor persisted small model is set', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).not.toHaveProperty('R_SMALL_MODEL');
    expect(env).not.toHaveProperty('R_VISION_MODEL');
  });

  it('falls back to persisted roomoteVisionModel when the env var is absent', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: 'openrouter/z-ai/glm-5.2',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).toEqual({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_VISION_MODEL: 'openrouter/z-ai/glm-5.2',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_VISION_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'OPENROUTER_API_KEY',
      OPENROUTER_API_KEY: 'sk-openrouter',
    });
  });

  it('falls back to persisted roomoteCodeReviewModel when the env var is absent', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: 'openrouter/z-ai/glm-5.2',
        roomoteExploreModel: 'openrouter/openai/gpt-5.4-mini',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).toEqual({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_CODE_REVIEW_MODEL: 'openrouter/z-ai/glm-5.2',
      R_EXPLORE_MODEL: 'openrouter/openai/gpt-5.4-mini',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'OPENROUTER_API_KEY',
      OPENROUTER_API_KEY: 'sk-openrouter',
    });
  });

  it('falls back to persisted roomoteExploreModel when the env var is absent', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteExploreModel: 'anthropic/claude-haiku-4',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
        ANTHROPIC_API_KEY: 'sk-anthropic',
      },
    });

    expect(env).toEqual({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_EXPLORE_MODEL: 'anthropic/claude-haiku-4',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'OPENROUTER_API_KEY,ANTHROPIC_API_KEY',
      OPENROUTER_API_KEY: 'sk-openrouter',
      ANTHROPIC_API_KEY: 'sk-anthropic',
    });
  });

  it('falls back to persisted roomotePlanningModel when the env var is absent', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomotePlanningModel: 'anthropic/claude-opus-4.7',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
        ANTHROPIC_API_KEY: 'sk-anthropic',
      },
    });

    expect(env).toEqual({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_PLANNING_MODEL: 'anthropic/claude-opus-4.7',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'OPENROUTER_API_KEY,ANTHROPIC_API_KEY',
      OPENROUTER_API_KEY: 'sk-openrouter',
      ANTHROPIC_API_KEY: 'sk-anthropic',
    });
  });

  it('prefers the R_PLANNING_MODEL env var over the persisted planning model', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomotePlanningModel: 'openrouter/z-ai/glm-5.2',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {
        R_PLANNING_MODEL: 'openrouter/anthropic/claude-opus-4.7',
      },
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).toMatchObject({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_PLANNING_MODEL: 'openrouter/anthropic/claude-opus-4.7',
      OPENROUTER_API_KEY: 'sk-openrouter',
    });
  });

  it('prefers the R_CODE_REVIEW_MODEL env var over the persisted code review model', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: 'openrouter/z-ai/glm-5.2',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {
        R_CODE_REVIEW_MODEL: 'openrouter/anthropic/claude-sonnet-4',
      },
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).toMatchObject({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_CODE_REVIEW_MODEL: 'openrouter/anthropic/claude-sonnet-4',
      OPENROUTER_API_KEY: 'sk-openrouter',
    });
  });

  it('prefers the R_EXPLORE_MODEL env var over the persisted explore model', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteExploreModel: 'openrouter/z-ai/glm-5.2',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {
        R_EXPLORE_MODEL: 'openrouter/anthropic/claude-haiku-4',
      },
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).toMatchObject({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_EXPLORE_MODEL: 'openrouter/anthropic/claude-haiku-4',
      OPENROUTER_API_KEY: 'sk-openrouter',
    });
  });

  it('resolves per-role reasoning efforts with env overrides winning over persisted values', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: null,
        roomoteExploreModel: null,
        roomoteModelReasoningEffort: 'low',
        roomoteSmallModelReasoningEffort: 'medium',
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: 'high',
        roomoteExploreModelReasoningEffort: 'xhigh',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {
        R_MODEL_REASONING_EFFORT: 'xhigh',
      },
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).toMatchObject({
      R_MODEL_REASONING_EFFORT: 'xhigh',
      R_SMALL_MODEL_REASONING_EFFORT: 'medium',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'xhigh',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
    });
    expect(env).not.toHaveProperty('R_VISION_MODEL_REASONING_EFFORT');
  });

  it('falls back to role defaults when configured reasoning values are invalid', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: null,
        roomoteModelReasoningEffort: 'turbo',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {
        R_SMALL_MODEL_REASONING_EFFORT: 'nonsense',
      },
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).toMatchObject({
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
    });
  });

  it('skips reasoning defaults for models known not to support reasoning', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/z-ai/glm-basic',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: null,
      },
      taskModelSettings: {
        models: [
          {
            id: 'openrouter/z-ai/glm-basic',
            displayName: 'GLM Basic',
            family: 'GLM',
            metadata: {
              contextWindow: null,
              inputTypes: null,
              inputPricePerToken: null,
              outputPricePerToken: null,
              lastRefreshedAt: null,
              supportsReasoning: false,
            },
          },
        ],
        allowedModelIds: ['openrouter/z-ai/glm-basic'],
        defaultModelId: 'openrouter/z-ai/glm-basic',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
      },
    });

    expect(env).not.toHaveProperty('R_MODEL_REASONING_EFFORT');
    expect(env).not.toHaveProperty('R_SMALL_MODEL_REASONING_EFFORT');
    expect(env).not.toHaveProperty('R_VISION_MODEL_REASONING_EFFORT');
    expect(env).not.toHaveProperty('R_CODE_REVIEW_MODEL_REASONING_EFFORT');
    expect(env).not.toHaveProperty('R_EXPLORE_MODEL_REASONING_EFFORT');
    expect(env).not.toHaveProperty('R_PLANNING_MODEL_REASONING_EFFORT');
  });

  it('infers provider keys from coding, helper, and vision models', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'openrouter/openai/gpt-5.4',
        roomoteSmallModel: 'anthropic/claude-haiku-4',
        roomoteVisionModel: 'openai/gpt-5.5',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        OPENROUTER_API_KEY: 'sk-openrouter',
        ANTHROPIC_API_KEY: 'sk-anthropic',
        OPENAI_API_KEY: 'sk-openai',
      },
    });

    expect(env).toEqual({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_SMALL_MODEL: 'anthropic/claude-haiku-4',
      R_VISION_MODEL: 'openai/gpt-5.5',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_VISION_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'OPENROUTER_API_KEY,ANTHROPIC_API_KEY,OPENAI_API_KEY',
      OPENROUTER_API_KEY: 'sk-openrouter',
      ANTHROPIC_API_KEY: 'sk-anthropic',
      OPENAI_API_KEY: 'sk-openai',
    });
  });

  it('forwards every declared env var for multi-credential providers', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: {
        roomoteModel: 'bedrock-mantle/anthropic.claude-sonnet-5',
        roomoteSmallModel: 'google-vertex/gemini-3.5-flash',
      },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
        AWS_REGION: 'us-west-2',
        GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account"}',
        GOOGLE_VERTEX_PROJECT: 'my-project',
      },
    });

    expect(env).toMatchObject({
      R_MODEL: 'bedrock-mantle/anthropic.claude-sonnet-5',
      R_SMALL_MODEL: 'google-vertex/gemini-3.5-flash',
      R_MODEL_ENV_KEYS:
        'AWS_BEARER_TOKEN_BEDROCK,AWS_REGION,GOOGLE_APPLICATION_CREDENTIALS,GOOGLE_VERTEX_PROJECT,GOOGLE_VERTEX_LOCATION',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
      AWS_REGION: 'us-west-2',
      GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account"}',
      GOOGLE_VERTEX_PROJECT: 'my-project',
    });
    expect(env).not.toHaveProperty('GOOGLE_VERTEX_LOCATION');
  });

  it('injects OPENCODE_AUTH_CONTENT when an openai/ model is used and the ChatGPT subscription is connected', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: { roomoteModel: 'openai/gpt-5.4' },
    });
    mockResolveOpenCodeAuthContent.mockResolvedValue(
      JSON.stringify({
        openai: {
          type: 'oauth',
          refresh: 'rt',
          access: 'at',
          expires: 123,
          accountId: 'acct',
        },
      }),
    );

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {},
    });

    expect(mockResolveOpenCodeAuthContent).toHaveBeenCalled();
    expect(env.OPENCODE_AUTH_CONTENT).toContain('"type":"oauth"');
  });

  it('emits the ChatGPT gateway marker instead of OPENCODE_AUTH_CONTENT in gateway mode', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: { roomoteModel: 'openai/gpt-5.4' },
    });
    mockResolveOpenCodeAuthContent.mockResolvedValue(
      JSON.stringify({
        openai: { type: 'oauth', refresh: 'rt', access: 'at', expires: 123 },
      }),
    );

    const env = await resolveEffectiveModelRuntimeEnv({
      inferenceGateway: true,
      runtimeEnv: {},
      deploymentEnvVars: {},
    });

    // The OAuth record must stay on the control plane; the marker tells the
    // worker to rebase the openai provider onto the gateway instead.
    expect(env).not.toHaveProperty('OPENCODE_AUTH_CONTENT');
    expect(env.R_INFERENCE_GATEWAY_CHATGPT).toBe('1');
  });

  it('does not emit the ChatGPT gateway marker when no subscription is connected', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: { roomoteModel: 'openai/gpt-5.4' },
    });
    mockResolveOpenCodeAuthContent.mockResolvedValue(null);

    const env = await resolveEffectiveModelRuntimeEnv({
      inferenceGateway: true,
      runtimeEnv: {},
      deploymentEnvVars: {},
    });

    expect(env).not.toHaveProperty('OPENCODE_AUTH_CONTENT');
    expect(env).not.toHaveProperty('R_INFERENCE_GATEWAY_CHATGPT');
  });

  it('does not inject OPENCODE_AUTH_CONTENT when no openai/ model is used', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: { roomoteModel: 'anthropic/claude-sonnet-4' },
    });

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: { ANTHROPIC_API_KEY: 'sk-anthropic' },
    });

    expect(mockResolveOpenCodeAuthContent).not.toHaveBeenCalled();
    expect(env).not.toHaveProperty('OPENCODE_AUTH_CONTENT');
  });

  it('omits OPENCODE_AUTH_CONTENT when the subscription is not connected', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      runtimeModelConfig: { roomoteModel: 'openai/gpt-5.4' },
    });
    mockResolveOpenCodeAuthContent.mockResolvedValue(null);

    const env = await resolveEffectiveModelRuntimeEnv({
      runtimeEnv: {},
      deploymentEnvVars: {},
    });

    expect(env).not.toHaveProperty('OPENCODE_AUTH_CONTENT');
  });

  describe('inference gateway', () => {
    beforeEach(() => {
      mockDeploymentSettingsFindFirst.mockResolvedValue({
        runtimeModelConfig: { roomoteModel: 'anthropic/claude-sonnet-4' },
      });
    });

    it('withholds gateway-served keys and advertises them by name when enabled', async () => {
      const env = await resolveEffectiveModelRuntimeEnv({
        inferenceGateway: true,
        runtimeEnv: {},
        deploymentEnvVars: { ANTHROPIC_API_KEY: 'sk-anthropic' },
      });

      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      // The worker builds the gateway URL from its own platform URL; the
      // resolver only advertises which keys it is serving.
      expect(env).not.toHaveProperty('R_INFERENCE_GATEWAY_URL');
      expect(env.R_INFERENCE_GATEWAY_KEYS).toBe('ANTHROPIC_API_KEY');
    });

    it('keeps raw keys when the gateway option is not passed', async () => {
      const env = await resolveEffectiveModelRuntimeEnv({
        runtimeEnv: {},
        deploymentEnvVars: { ANTHROPIC_API_KEY: 'sk-anthropic' },
      });

      expect(env.ANTHROPIC_API_KEY).toBe('sk-anthropic');
      expect(env).not.toHaveProperty('R_INFERENCE_GATEWAY_KEYS');
    });

    it('advertises only configured covered keys, not every set covered key', async () => {
      // OpenAI is not a configured role model, so even though OPENAI_API_KEY is
      // set it is neither served nor advertised — the dequeue redaction keys
      // off the advertised set, so a stray OPENAI_API_KEY the deployment set
      // for its own code survives into the sandbox.
      const env = await resolveEffectiveModelRuntimeEnv({
        inferenceGateway: true,
        runtimeEnv: {},
        deploymentEnvVars: {
          ANTHROPIC_API_KEY: 'sk-anthropic',
          OPENAI_API_KEY: 'sk-openai-for-user-code',
        },
      });

      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(env.R_INFERENCE_GATEWAY_KEYS).toBe('ANTHROPIC_API_KEY');
    });

    it('withholds credentials for every enabled switchable model provider', async () => {
      mockDeploymentSettingsFindFirst.mockResolvedValue({
        runtimeModelConfig: {
          roomoteModel: 'openrouter/openai/gpt-5.6-terra',
          roomotePlanningModel: 'openrouter/anthropic/claude-opus-4.8',
        },
        taskModelSettings: {
          models: [
            {
              id: 'openrouter/openai/gpt-5.6-terra',
              displayName: 'GPT 5.6 Terra',
              family: 'GPT',
            },
            {
              id: 'anthropic/claude-sonnet-5',
              displayName: 'Claude Sonnet 5',
              family: 'Sonnet',
            },
            {
              id: 'openai/gpt-5.6-luna',
              displayName: 'GPT 5.6 Luna',
              family: 'GPT',
            },
          ],
          allowedModelIds: [
            'openrouter/openai/gpt-5.6-terra',
            'anthropic/claude-sonnet-5',
            'openai/gpt-5.6-luna',
          ],
          defaultModelId: 'openrouter/openai/gpt-5.6-terra',
        },
      });
      mockResolveOpenCodeAuthContent.mockResolvedValue(
        JSON.stringify({
          openai: { type: 'oauth', refresh: 'rt', access: 'at', expires: 123 },
        }),
      );

      const env = await resolveEffectiveModelRuntimeEnv({
        inferenceGateway: true,
        runtimeEnv: {},
        deploymentEnvVars: {
          OPENROUTER_API_KEY: 'sk-openrouter',
          ANTHROPIC_API_KEY: 'sk-anthropic',
        },
      });

      expect(env).not.toHaveProperty('OPENROUTER_API_KEY');
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(env.R_INFERENCE_GATEWAY_KEYS).toBe(
        'OPENROUTER_API_KEY,ANTHROPIC_API_KEY',
      );
      expect(env.R_INFERENCE_GATEWAY_CHATGPT).toBe('1');
      expect(env).not.toHaveProperty('OPENCODE_AUTH_CONTENT');
    });

    it('withholds Bedrock but keeps Vertex, which the gateway cannot serve', async () => {
      const env = await resolveEffectiveModelRuntimeEnv({
        inferenceGateway: true,
        runtimeEnv: {
          R_MODEL_ENV_KEYS:
            'ANTHROPIC_API_KEY,AWS_BEARER_TOKEN_BEDROCK,GOOGLE_APPLICATION_CREDENTIALS',
        },
        deploymentEnvVars: {
          ANTHROPIC_API_KEY: 'sk-anthropic',
          AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
          GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account"}',
        },
      });

      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(env).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
      // Vertex needs request signing, not header injection, so its
      // credentials still flow.
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(
        '{"type":"service_account"}',
      );
      expect(env.R_INFERENCE_GATEWAY_KEYS).toBe(
        'ANTHROPIC_API_KEY,AWS_BEARER_TOKEN_BEDROCK',
      );
    });
  });
});
