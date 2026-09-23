import {
  DEFAULT_SETUP_REDIRECT_PATH,
  getSetupRedirectPath,
} from './setup-status';

describe('setup-status', () => {
  it('lets completed deployments through regardless of provider (GitLab-only has no GitHub installation)', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: false,
        hasEnvironments: false,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('routes orgs missing environments back to setup while initial setup is still incomplete', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: true,
        hasEnvironments: false,
        setupCompletedAt: null,
      }),
    ).toBe(DEFAULT_SETUP_REDIRECT_PATH);
  });

  it('does not redirect previously completed orgs with no environments', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: true,
        hasEnvironments: false,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('does not redirect completed setups when GitHub and environments exist', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: true,
        hasEnvironments: true,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('provides the initial setup route until setupCompletedAt is written', () => {
    expect(
      getSetupRedirectPath({
        hasGitHub: true,
        hasEnvironments: true,
        setupCompletedAt: null,
      }),
    ).toBe(DEFAULT_SETUP_REDIRECT_PATH);
  });
});
