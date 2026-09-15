import {
  isSessionSecretToolsExperimentEnabled,
  SESSION_SECRET_TOOLS_EXPERIMENT_KEY,
} from './session-secrets';

describe('Session secret tools experiment', () => {
  it('uses a stable identifier and defaults off', () => {
    expect(SESSION_SECRET_TOOLS_EXPERIMENT_KEY).toBe(
      'session_secret_tools_enabled',
    );
    expect(isSessionSecretToolsExperimentEnabled(undefined)).toBe(false);
    expect(isSessionSecretToolsExperimentEnabled({})).toBe(false);
  });

  it('enables only for an explicit boolean true', () => {
    expect(
      isSessionSecretToolsExperimentEnabled({
        session_secret_tools_enabled: true,
      }),
    ).toBe(true);
    expect(
      isSessionSecretToolsExperimentEnabled({
        session_secret_tools_enabled: 'true',
      }),
    ).toBe(false);
  });
});
