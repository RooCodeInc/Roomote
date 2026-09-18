import { getMcpIntegration } from '@roomote/types';

import {
  getStaticOauthReadiness,
  getStaticOauthEnvPartnerKey,
  resolveStaticOauthClientInformation,
} from './mcp-static-oauth';

describe('Linear static OAuth configuration', () => {
  const linear = getMcpIntegration('linear');
  const notion = getMcpIntegration('notion');

  it('pairs and resolves the configured client credentials', () => {
    expect(getStaticOauthEnvPartnerKey('R_LINEAR_CLIENT_ID')).toBe(
      'R_LINEAR_CLIENT_SECRET',
    );
    expect(
      resolveStaticOauthClientInformation(
        {
          R_LINEAR_CLIENT_ID: 'linear-client',
          R_LINEAR_CLIENT_SECRET: 'linear-secret',
        },
        linear!,
      ),
    ).toEqual({
      client_id: 'linear-client',
      client_secret: 'linear-secret',
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  it('rejects partial credential configuration', () => {
    expect(
      resolveStaticOauthClientInformation(
        { R_LINEAR_CLIENT_ID: 'linear-client' },
        linear!,
      ),
    ).toBeUndefined();
  });

  it.each([
    {
      env: {
        R_LINEAR_CLIENT_ID: 'linear-client',
        R_LINEAR_CLIENT_SECRET: 'linear-secret',
      },
      expected: 'ready',
    },
    { env: {}, expected: 'missing' },
    {
      env: { R_LINEAR_CLIENT_ID: 'linear-client' },
      expected: 'partial',
    },
  ] as const)('reports $expected OAuth readiness', ({ env, expected }) => {
    expect(getStaticOauthReadiness(env, linear!)).toBe(expected);
  });

  it('reports that integrations without static credentials need no setup', () => {
    expect(getStaticOauthReadiness({}, getMcpIntegration('jira')!)).toBe(
      'not_required',
    );
  });

  it('resolves Notion public-connection credentials with basic authentication', () => {
    expect(getStaticOauthEnvPartnerKey('R_NOTION_CLIENT_ID')).toBe(
      'R_NOTION_CLIENT_SECRET',
    );
    expect(
      resolveStaticOauthClientInformation(
        {
          R_NOTION_CLIENT_ID: 'notion-client',
          R_NOTION_CLIENT_SECRET: 'notion-secret',
        },
        notion!,
      ),
    ).toEqual({
      client_id: 'notion-client',
      client_secret: 'notion-secret',
      token_endpoint_auth_method: 'client_secret_basic',
    });
  });
});
