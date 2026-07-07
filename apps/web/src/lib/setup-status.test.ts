import { getSetupRedirectPath, requiresSetup } from './setup-status';

describe('setup-status', () => {
  it('routes orgs without GitHub to the setup flow', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: false,
        hasEnvironments: false,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('/setup');
    expect(
      requiresSetup({
        hasGitHub: false,
        hasEnvironments: false,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('routes orgs missing environments back to setup while initial setup is still incomplete', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: true,
        hasEnvironments: false,
        setupCompletedAt: null,
      }),
    ).toBe('/setup');
  });

  it('allows previously completed orgs with no environments to continue through the app', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: true,
        hasEnvironments: false,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
    expect(
      requiresSetup({
        hasGitHub: true,
        hasEnvironments: false,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('does not require setup when GitHub and environments already exist', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: true,
        hasEnvironments: true,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
    expect(
      requiresSetup({
        hasGitHub: true,
        hasEnvironments: true,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('still requires setup until setupCompletedAt is written even when GitHub and environments exist', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: true,
        hasEnvironments: true,
        setupCompletedAt: null,
      }),
    ).toBe('/setup');
    expect(
      requiresSetup({
        hasGitHub: true,
        hasEnvironments: true,
        setupCompletedAt: null,
      }),
    ).toBe(true);
  });

  it('requires setup when environments already exist without GitHub', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: false,
        hasEnvironments: true,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('/setup');
    expect(
      requiresSetup({
        hasGitHub: false,
        hasEnvironments: true,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(true);
  });
});
