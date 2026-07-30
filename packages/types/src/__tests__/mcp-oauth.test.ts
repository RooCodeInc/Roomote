import {
  getMcpIntegration,
  getMcpIntegrationAuthorizationParameters,
  getMcpIntegrationConnectionScope,
  getMcpIntegrationOauthScopeMode,
  getMcpIntegrationOauthScopes,
  LINEAR_APP_OAUTH_SCOPES,
  MONDAY_MCP_READ_ONLY_OAUTH_SCOPES,
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

  it('uses the OAuth user actor for personal account links', () => {
    expect(
      getMcpIntegrationAuthorizationParameters('linear', 'linear_user_link'),
    ).toEqual([{ name: 'actor', value: 'user' }]);
  });
});

describe('monday.com OAuth', () => {
  it('uses the hosted MCP with a user-scoped read-only connection', () => {
    expect(getMcpIntegration('monday')).toMatchObject({
      name: 'monday.com',
      url: 'https://mcp.monday.com/mcp',
      serverMode: 'upstream_proxy',
    });
    expect(getMcpIntegrationConnectionScope('monday')).toBe('user');
    expect(getMcpIntegrationOauthScopeMode('monday')).toBe('read-only');
    expect(getMcpIntegrationOauthScopes('monday')).toEqual(
      MONDAY_MCP_READ_ONLY_OAUTH_SCOPES,
    );
    expect(getMcpIntegrationOauthScopes('monday')).not.toContain(
      'webhooks:read',
    );
  });
});
