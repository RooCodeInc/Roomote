import {
  getMcpIntegration,
  getMcpIntegrationAuthorizationParameters,
  getMcpIntegrationConnectionScope,
  getMcpIntegrationDefaultDisabledTools,
  getMcpIntegrationOauthScopeMode,
  getMcpIntegrationOauthScopes,
  isMcpConnectionElevenLabsConfig,
  LINEAR_APP_OAUTH_SCOPES,
  MONDAY_MCP_READ_ONLY_OAUTH_SCOPES,
  RESEND_DEFAULT_DISABLED_TOOL_NAMES,
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

describe('Granola API key connection', () => {
  it('uses a deployment-scoped native MCP with admin-managed credentials', () => {
    expect(getMcpIntegration('granola')).toMatchObject({
      name: 'Granola',
      connectionScope: 'deployment',
      connectionMode: 'admin_configured',
      serverMode: 'native',
    });
    expect(getMcpIntegration('granola')?.url).toBeUndefined();
    expect(getMcpIntegrationConnectionScope('granola')).toBe('deployment');
    expect(getMcpIntegrationOauthScopeMode('granola')).toBeUndefined();
    expect(getMcpIntegrationDefaultDisabledTools('granola')).toEqual([]);
  });
});

describe('ElevenLabs credential-only integration', () => {
  it('is a deployment-scoped credential_only entry with no MCP url', () => {
    expect(getMcpIntegration('elevenlabs')).toMatchObject({
      name: 'ElevenLabs',
      connectionScope: 'deployment',
      connectionMode: 'admin_configured',
      serverMode: 'credential_only',
    });
    expect(getMcpIntegration('elevenlabs')?.url).toBeUndefined();
    expect(getMcpIntegrationDefaultDisabledTools('elevenlabs')).toEqual([]);
  });

  it('recognizes a valid stored ElevenLabs config and rejects others', () => {
    expect(
      isMcpConnectionElevenLabsConfig({
        type: 'elevenlabs',
        encryptedApiKey: 'enc',
        voiceId: 'v1',
      }),
    ).toBe(true);
    // Missing voiceId, wrong type, and empty configs must not pass.
    expect(
      isMcpConnectionElevenLabsConfig({
        type: 'elevenlabs',
        encryptedApiKey: 'enc',
      } as never),
    ).toBe(false);
    expect(
      isMcpConnectionElevenLabsConfig({
        type: 'granola',
        encryptedApiKey: 'x',
      }),
    ).toBe(false);
    expect(isMcpConnectionElevenLabsConfig({})).toBe(false);
  });
});

describe('Resend OAuth', () => {
  it('uses a deployment-scoped hosted MCP with risky tools disabled initially', () => {
    expect(getMcpIntegration('resend')).toMatchObject({
      name: 'Resend',
      url: 'https://mcp.resend.com/mcp',
      connectionMode: 'oauth',
      serverMode: 'upstream_proxy',
      oauthScopes: ['full_access'],
      oauthEndpoints: {
        authorizationEndpoint: 'https://api.resend.com/oauth/authorize',
        tokenEndpoint: 'https://api.resend.com/oauth/token',
        registrationEndpoint: 'https://api.resend.com/oauth/register',
        tokenEndpointAuthMethod: 'none',
      },
    });
    expect(getMcpIntegrationConnectionScope('resend')).toBe('deployment');
    expect(getMcpIntegrationDefaultDisabledTools('resend')).toEqual(
      RESEND_DEFAULT_DISABLED_TOOL_NAMES,
    );
    expect(RESEND_DEFAULT_DISABLED_TOOL_NAMES).toEqual([
      'send-email',
      'send-batch-emails',
      'send-broadcast',
      'update-email',
      'create-contact',
      'update-contact',
      'remove-contact',
      'add-contact-to-segment',
      'remove-contact-from-segment',
      'update-contact-topics',
      'create-contact-import',
      'create-automation',
      'update-automation',
      'send-event',
      'create-api-key',
      'remove-api-key',
      'create-contact-property',
      'update-contact-property',
      'remove-contact-property',
      'update-domain',
      'remove-domain',
      'create-webhook',
      'update-webhook',
    ]);
    expect(RESEND_DEFAULT_DISABLED_TOOL_NAMES).toHaveLength(23);
    expect(getMcpIntegrationDefaultDisabledTools('resend')).not.toContain(
      'cancel-email',
    );
    expect(getMcpIntegrationDefaultDisabledTools('resend')).not.toContain(
      'list-contacts',
    );
  });
});
