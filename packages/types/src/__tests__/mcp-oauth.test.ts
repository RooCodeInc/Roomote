import {
  getMcpIntegrationOauthScopes,
  LINEAR_APP_OAUTH_SCOPES,
} from '../mcp-oauth';

describe('Linear OAuth scopes', () => {
  it('makes deployment app actors assignable and mentionable', () => {
    expect(
      getMcpIntegrationOauthScopes('linear', 'linear_org_install'),
    ).toEqual(LINEAR_APP_OAUTH_SCOPES);
  });

  it('keeps personal account links read-only', () => {
    expect(getMcpIntegrationOauthScopes('linear', 'linear_user_link')).toEqual([
      'read',
    ]);
  });
});
