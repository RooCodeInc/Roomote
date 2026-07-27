import {
  buildRouterDebugSettingsInput,
  getRouterDebugDestinationSelection,
  ROUTER_DEBUG_ENV_FALLBACK,
  ROUTER_DEBUG_NONE,
} from './router-diagnostics-destination';

describe('router diagnostics destination settings', () => {
  it('distinguishes an env fallback from a persisted Slack destination', () => {
    expect(
      getRouterDebugDestinationSelection({
        destination: { provider: 'slack', channelId: 'CENV123456' },
        disabled: false,
        source: 'env',
      }),
    ).toBe(ROUTER_DEBUG_ENV_FALLBACK);
  });

  it('persists no destination as explicitly disabled', () => {
    expect(buildRouterDebugSettingsInput(ROUTER_DEBUG_NONE, '')).toEqual({
      provider: null,
      channelId: null,
      disabled: true,
    });
  });

  it('can restore inheritance from the environment fallback', () => {
    expect(
      buildRouterDebugSettingsInput(ROUTER_DEBUG_ENV_FALLBACK, 'ignored'),
    ).toEqual({
      provider: null,
      channelId: null,
      disabled: false,
    });
  });
});
