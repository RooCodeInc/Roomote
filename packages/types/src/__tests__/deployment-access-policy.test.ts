import { normalizeDeploymentAccessPolicy } from '../deployment-access-policy';

describe('normalizeDeploymentAccessPolicy', () => {
  it('returns null for missing or malformed values', () => {
    expect(normalizeDeploymentAccessPolicy(null)).toBeNull();
    expect(normalizeDeploymentAccessPolicy(undefined)).toBeNull();
    expect(normalizeDeploymentAccessPolicy('open')).toBeNull();
    expect(normalizeDeploymentAccessPolicy([])).toBeNull();
  });

  it('normalizes the slack workspace anchor', () => {
    expect(normalizeDeploymentAccessPolicy({ slackTeamId: ' T123 ' })).toEqual({
      slackTeamId: 'T123',
    });
    expect(normalizeDeploymentAccessPolicy({ slackTeamId: '' })).toEqual({
      slackTeamId: null,
    });
    expect(normalizeDeploymentAccessPolicy({})).toEqual({
      slackTeamId: null,
    });
  });
});
