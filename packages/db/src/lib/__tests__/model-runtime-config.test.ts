const { mockGetPersistedModelProviderEnvironmentVariableValues } = vi.hoisted(
  () => ({
    mockGetPersistedModelProviderEnvironmentVariableValues: vi.fn(),
  }),
);

vi.mock('../model-provider-environment-variables', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../model-provider-environment-variables')
  >()),
  getPersistedModelProviderEnvironmentVariableValues:
    mockGetPersistedModelProviderEnvironmentVariableValues,
}));

import { resolveModelProviderEnvValue } from '../model-runtime-config';
import type { DatabaseOrTransaction } from '../../db';

describe('resolveModelProviderEnvValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks all runtime aliases before querying persisted values', async () => {
    mockGetPersistedModelProviderEnvironmentVariableValues.mockResolvedValue({
      GEMINI_API_KEY: 'persisted-key',
    });

    const value = await resolveModelProviderEnvValue(
      ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
      {
        runtimeEnv: { GOOGLE_GENERATIVE_AI_API_KEY: 'runtime-alias-key' },
      },
    );

    expect(value).toBe('runtime-alias-key');
    expect(
      mockGetPersistedModelProviderEnvironmentVariableValues,
    ).not.toHaveBeenCalled();
  });

  it('looks up only the requested persisted key', async () => {
    const executor = {} as DatabaseOrTransaction;
    mockGetPersistedModelProviderEnvironmentVariableValues.mockResolvedValue({
      OPENAI_API_KEY: 'persisted-key',
    });

    const value = await resolveModelProviderEnvValue('OPENAI_API_KEY', {
      runtimeEnv: {},
      executor,
    });

    expect(value).toBe('persisted-key');
    expect(
      mockGetPersistedModelProviderEnvironmentVariableValues,
    ).toHaveBeenCalledWith(['OPENAI_API_KEY'], executor);
  });
});
