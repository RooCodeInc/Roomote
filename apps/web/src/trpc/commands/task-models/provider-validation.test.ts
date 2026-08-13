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

import {
  assertInferenceProviderConnection,
  InferenceProviderValidationError,
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

  it('keeps runtime env precedence over saved and submitted values', async () => {
    process.env.ANTHROPIC_API_KEY = 'runtime-key';

    await assertInferenceProviderConnection({
      providerLabel: 'Anthropic',
      providerEnvVarNames: ['ANTHROPIC_API_KEY'],
      modelId: 'anthropic/claude-sonnet-5',
      credentialValues: [{ name: 'ANTHROPIC_API_KEY', value: 'candidate-key' }],
    });

    expect(mockValidateNonTaskInference).toHaveBeenCalledWith({
      model: 'anthropic/claude-sonnet-5',
      runtimeEnv: {},
    });
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
