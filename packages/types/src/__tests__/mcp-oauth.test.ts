import {
  getMcpIntegrationAuthorizationParameters,
  getMcpIntegrationOauthScopes,
  LINEAR_APP_OAUTH_SCOPES,
} from '../mcp-oauth';

describe('Linear OAuth scopes', () => {
  it('makes deployment app actors assignable and mentionable', () => {
    expect(
      getMcpIntegrationOauthScopes('linear', 'linear_org_install'),
    ).toEqual(LINEAR_APP_OAUTH_SCOPES);
  });

  it('allows personal account links to report agent activity', () => {
    expect(getMcpIntegrationOauthScopes('linear', 'linear_user_link')).toEqual([
      'read',
      'write',
    ]);
  });

  it('uses the OAuth app actor for personal account links', () => {
    expect(
      getMcpIntegrationAuthorizationParameters('linear', 'linear_user_link'),
    ).toEqual([{ name: 'actor', value: 'app' }]);
  });
});
