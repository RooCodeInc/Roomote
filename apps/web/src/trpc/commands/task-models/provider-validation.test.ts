const { mockResolveEffectiveDeploymentEnvVars, mockValidateNonTaskInference } =
  vi.hoisted(() => ({
    mockResolveEffectiveDeploymentEnvVars: vi.fn(),
    mockValidateNonTaskInference: vi.fn(),
  }));

vi.mock('@roomote/db/server', () => ({
  resolveEffectiveDeploymentEnvVars: mockResolveEffectiveDeploymentEnvVars,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  validateNonTaskInference: mockValidateNonTaskInference,
}));

import { getSetupModelProvider } from '@roomote/types';

import {
  InferenceProviderValidationError,
  assertInferenceProviderConnection,
  validateBedrockApiKey,
  validateSetupModelProviderCredentials,
} from './provider-validation';

describe('assertInferenceProviderConnection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    mockResolveEffectiveDeploymentEnvVars.mockResolvedValue({
      ANTHROPIC_API_KEY: 'saved-key',
      AWS_REGION: 'us-east-1',
    });
    mockValidateNonTaskInference.mockResolvedValue({
      success: true,
      checkedAt: '2026-08-13T12:00:00.000Z',
      latencyMs: 25,
      model: 'anthropic/claude-sonnet-5',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('overlays submitted credentials without persisting them first', async () => {
    await assertInferenceProviderConnection({
      providerLabel: 'Anthropic',
      providerEnvVarNames: ['ANTHROPIC_API_KEY'],
      modelId: 'anthropic/claude-sonnet-5',
      credentialValues: [{ name: 'ANTHROPIC_API_KEY', value: 'candidate-key' }],
    });

    expect(mockValidateNonTaskInference).toHaveBeenCalledWith({
      model: 'anthropic/claude-sonnet-5',
      runtimeEnv: {
        ANTHROPIC_API_KEY: 'candidate-key',
      },
    });
  });

  it('still validates the submitted credential when a runtime env var shadows it', async () => {
    process.env.ANTHROPIC_API_KEY = 'runtime-key';

    await assertInferenceProviderConnection({
      providerLabel: 'Anthropic',
      providerEnvVarNames: ['ANTHROPIC_API_KEY'],
      modelId: 'anthropic/claude-sonnet-5',
      credentialValues: [{ name: 'ANTHROPIC_API_KEY', value: 'candidate-key' }],
    });

    // The submitted value is what the save persists, so it is the value
    // exercised even though this process would resolve the runtime key.
    expect(mockValidateNonTaskInference).toHaveBeenCalledWith({
      model: 'anthropic/claude-sonnet-5',
      runtimeEnv: { ANTHROPIC_API_KEY: 'candidate-key' },
    });
  });

  it('does not block the save on failures that do not indict the credentials', async () => {
    mockValidateNonTaskInference.mockResolvedValue({
      success: false,
      checkedAt: '2026-08-13T12:00:00.000Z',
      latencyMs: 25,
      message: 'The selected model is unavailable with these credentials.',
      model: 'anthropic/claude-sonnet-5',
      reason: 'model_unavailable',
      retryable: false,
    });

    await expect(
      assertInferenceProviderConnection({
        providerLabel: 'Anthropic',
        providerEnvVarNames: ['ANTHROPIC_API_KEY'],
        modelId: 'anthropic/claude-sonnet-5',
        credentialValues: [
          { name: 'ANTHROPIC_API_KEY', value: 'candidate-key' },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('throws only the sanitized provider failure', async () => {
    mockValidateNonTaskInference.mockResolvedValue({
      success: false,
      checkedAt: '2026-08-13T12:00:00.000Z',
      latencyMs: 25,
      message: 'The inference provider rejected these credentials.',
      model: 'anthropic/claude-sonnet-5',
      reason: 'invalid_credentials',
      retryable: false,
    });

    await expect(
      assertInferenceProviderConnection({
        providerLabel: 'Anthropic',
        providerEnvVarNames: ['ANTHROPIC_API_KEY'],
        modelId: 'anthropic/claude-sonnet-5',
        credentialValues: [
          { name: 'ANTHROPIC_API_KEY', value: 'candidate-key' },
        ],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<InferenceProviderValidationError>>({
        code: 'invalid_credentials',
        message:
          'Anthropic: The inference provider rejected these credentials.',
        retryable: false,
      }),
    );
  });
});

describe('validateSetupModelProviderCredentials', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    mockResolveEffectiveDeploymentEnvVars.mockResolvedValue({
      ANTHROPIC_API_KEY: 'saved-key',
    });
    mockValidateNonTaskInference.mockResolvedValue({
      success: true,
      checkedAt: '2026-08-13T12:00:00.000Z',
      latencyMs: 25,
      model: 'anthropic/claude-sonnet-5',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('skips the live check when the save changes no credentials', async () => {
    await validateSetupModelProviderCredentials({
      provider: getSetupModelProvider('anthropic'),
      action: 'save it',
      modelId: 'anthropic/claude-sonnet-5',
    });

    expect(mockValidateNonTaskInference).not.toHaveBeenCalled();
  });

  it('skips the live check when the UI resubmits the persisted value unchanged', async () => {
    await validateSetupModelProviderCredentials({
      provider: getSetupModelProvider('anthropic'),
      apiKey: 'saved-key',
      action: 'save it',
      modelId: 'anthropic/claude-sonnet-5',
    });

    expect(mockValidateNonTaskInference).not.toHaveBeenCalled();
  });

  it('validates a submitted credential once against the persisted env', async () => {
    await validateSetupModelProviderCredentials({
      provider: getSetupModelProvider('anthropic'),
      apiKey: 'candidate-key',
      action: 'save it',
      modelId: 'anthropic/claude-sonnet-5',
    });

    expect(mockResolveEffectiveDeploymentEnvVars).toHaveBeenCalledTimes(1);
    expect(mockValidateNonTaskInference).toHaveBeenCalledWith({
      model: 'anthropic/claude-sonnet-5',
      runtimeEnv: { ANTHROPIC_API_KEY: 'candidate-key' },
    });
  });
});

describe('validateBedrockApiKey', () => {
  const originalEnv = process.env;
  const fetchMock = vi.fn();
  const bedrock = getSetupModelProvider('amazon-bedrock');

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_REGION;
    vi.stubGlobal('fetch', fetchMock);
    mockResolveEffectiveDeploymentEnvVars.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('rejects a key the regional Mantle listing answers 401 for', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(
      validateBedrockApiKey({
        provider: bedrock,
        apiKey: 'wrong-key',
        additionalEnvValues: { AWS_REGION: 'us-west-2' },
        action: 'save it',
      }),
    ).rejects.toThrow('Amazon Bedrock: the API key was not accepted');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bedrock-mantle.us-west-2.api.aws/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer wrong-key' },
      }),
    );
  });

  it('does not block on answers that do not indict the key', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(
      validateBedrockApiKey({
        provider: bedrock,
        apiKey: 'scoped-key',
        action: 'save it',
      }),
    ).resolves.toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(
      validateBedrockApiKey({
        provider: bedrock,
        apiKey: 'scoped-key',
        action: 'save it',
      }),
    ).resolves.toBeUndefined();
  });

  it('skips the probe when the save changes nothing', async () => {
    mockResolveEffectiveDeploymentEnvVars.mockResolvedValue({
      AWS_BEARER_TOKEN_BEDROCK: 'saved-key',
    });

    await validateBedrockApiKey({
      provider: bedrock,
      apiKey: 'saved-key',
      action: 'save it',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed region before building the probe URL', async () => {
    await expect(
      validateBedrockApiKey({
        provider: bedrock,
        apiKey: 'key',
        additionalEnvValues: { AWS_REGION: 'evil.example.com/x' },
        action: 'save it',
      }),
    ).rejects.toThrow('AWS_REGION must be a valid AWS region');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
