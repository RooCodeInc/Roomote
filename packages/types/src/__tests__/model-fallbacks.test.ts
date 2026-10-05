import {
  MODEL_FALLBACK_AGENT_ROLES,
  MODEL_FALLBACK_PROVIDER_ERROR_RETRIES,
  classifyModelFallbackTrigger,
  normalizeModelFallbackConfig,
  resolveRoleFallback,
} from '../model-fallbacks';

describe('model fallbacks', () => {
  it('normalizes known roles, aliases, and reasoning', () => {
    expect(
      normalizeModelFallbackConfig({
        enabled: true,
        roles: {
          coding: {
            modelId: ' anthropic/claude-sonnet-4 ',
            reasoningEffort: 'high',
          },
          unknown: { modelId: 'openai/gpt-5.4' },
        },
      }),
    ).toEqual({
      enabled: true,
      roles: {
        coding: {
          modelId: 'anthropic/claude-sonnet-4',
          reasoningEffort: 'high',
        },
      },
    });
  });

  it('resolves only enabled, distinct role fallbacks', () => {
    const config = normalizeModelFallbackConfig({
      enabled: true,
      roles: { coding: { modelId: 'openai/gpt-5.4', reasoningEffort: null } },
    });
    expect(
      resolveRoleFallback(config, 'coding', 'anthropic/claude-sonnet-4'),
    ).toEqual(config.roles.coding);
    expect(resolveRoleFallback(config, 'coding', 'openai/gpt-5.4')).toBeNull();
    expect(
      resolveRoleFallback({ ...config, enabled: false }, 'coding', 'x/y'),
    ).toBeNull();
  });

  it.each([
    [{ name: 'ProviderAuthError', status: 401 }, 0, 'immediate'],
    [{ name: 'ProviderAuthError', status: 403 }, 0, 'immediate'],
    [{ name: 'ProviderModelNotFoundError', status: 404 }, 0, 'immediate'],
    [{ status: 429 }, MODEL_FALLBACK_PROVIDER_ERROR_RETRIES - 1, null],
    [{ status: 429 }, MODEL_FALLBACK_PROVIDER_ERROR_RETRIES, 'after_retries'],
    [{ status: 503 }, MODEL_FALLBACK_PROVIDER_ERROR_RETRIES, 'after_retries'],
    [{ name: 'ContextOverflowError' }, 99, null],
    [{ name: 'ContentFilterError' }, 99, null],
  ])('classifies %j after %i retries', (error, retriesUsed, expected) => {
    expect(classifyModelFallbackTrigger(error, { retriesUsed })).toBe(expected);
  });

  it('keeps HTML gateway 403 responses on the retry path', () => {
    const error = {
      name: 'ProviderAuthError',
      data: { statusCode: 403, responseBody: '<html>blocked</html>' },
    };
    expect(classifyModelFallbackTrigger(error, { retriesUsed: 0 })).toBeNull();
    expect(
      classifyModelFallbackTrigger(error, {
        retriesUsed: MODEL_FALLBACK_PROVIDER_ERROR_RETRIES,
      }),
    ).toBe('after_retries');
  });

  it('maps supported OpenCode agents to model roles', () => {
    expect(MODEL_FALLBACK_AGENT_ROLES).toEqual({
      visual: 'vision',
      judge: 'vision',
      advisor: 'planning',
      explore: 'explore',
    });
  });
});
