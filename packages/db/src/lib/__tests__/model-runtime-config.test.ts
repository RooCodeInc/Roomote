const { mockResolveDeploymentEnvVar } = vi.hoisted(() => ({
  mockResolveDeploymentEnvVar: vi.fn(),
}));

vi.mock('../environment-variables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../environment-variables')>()),
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
}));

import {
  DevLoginInferencePlaceholderError,
  resolveModelProviderEnvValue,
} from '../model-runtime-config';
import { DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER } from '@roomote/types';
import type { DatabaseOrTransaction } from '../../db';

describe('resolveModelProviderEnvValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks all runtime aliases before querying persisted values', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValue('persisted-key');

    const value = await resolveModelProviderEnvValue(
      ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
      {
        runtimeEnv: { GOOGLE_GENERATIVE_AI_API_KEY: 'runtime-alias-key' },
      },
    );

    expect(value).toBe('runtime-alias-key');
    expect(mockResolveDeploymentEnvVar).not.toHaveBeenCalled();
  });

  it('looks up only the requested persisted key', async () => {
    const executor = {} as DatabaseOrTransaction;
    mockResolveDeploymentEnvVar.mockResolvedValue('persisted-key');

    const value = await resolveModelProviderEnvValue('OPENAI_API_KEY', {
      runtimeEnv: {},
      executor,
    });

    expect(value).toBe('persisted-key');
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledWith(
      'OPENAI_API_KEY',
      executor,
      {},
    );
  });

  it('rejects the dev-login placeholder before returning a runtime key', async () => {
    await expect(
      resolveModelProviderEnvValue('OPENROUTER_API_KEY', {
        runtimeEnv: {
          OPENROUTER_API_KEY: DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER,
        },
      }),
    ).rejects.toBeInstanceOf(DevLoginInferencePlaceholderError);
    expect(mockResolveDeploymentEnvVar).not.toHaveBeenCalled();
  });

  it('rejects the dev-login placeholder before returning a saved key', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValue(
      DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER,
    );

    await expect(
      resolveModelProviderEnvValue('OPENROUTER_API_KEY', { runtimeEnv: {} }),
    ).rejects.toThrow(
      'Configure a real inference provider in Settings > Models',
    );
  });
});
