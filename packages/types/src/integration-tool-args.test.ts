import {
  hasIntegrationToolSecret,
  redactIntegrationToolArgs,
} from './integration-tool-args';

const openRouterKey = `sk-or-v1-${'a'.repeat(32)}`;
const apiKey = `sk-${'b'.repeat(28)}`;
const githubClassicToken = `ghp_${'c'.repeat(36)}`;
const githubOAuthToken = `gho_${'d'.repeat(36)}`;
const githubFineGrainedToken = `github_pat_${'e'.repeat(32)}`;
const slackBotToken = `xoxb-${'1'.repeat(18)}-${'2'.repeat(18)}`;
const slackUserToken = `xoxp-${'3'.repeat(18)}-${'4'.repeat(18)}`;
const awsAccessKeyId = `AKIA${'F'.repeat(16)}`;

describe('integration tool argument secret handling', () => {
  it('detects supported credential shapes in nested argument values', () => {
    expect(
      hasIntegrationToolSecret({
        first: [openRouterKey, { apiKey }],
        credentials: {
          github: githubClassicToken,
          oauth: githubOAuthToken,
          fineGrained: githubFineGrainedToken,
          slack: slackBotToken,
          userSlack: slackUserToken,
          aws: awsAccessKeyId,
          pem: '-----BEGIN RSA PRIVATE KEY-----',
        },
      }),
    ).toBe(true);
  });

  it('decodes URL-encoded values and scans past the preview limit', () => {
    expect(
      hasIntegrationToolSecret({
        url: `https://example.invalid/search?q=${encodeURIComponent(openRouterKey)}`,
      }),
    ).toBe(true);
    expect(
      hasIntegrationToolSecret({ query: `${'x'.repeat(250)} ${apiKey}` }),
    ).toBe(true);
    expect(
      redactIntegrationToolArgs({ query: `${'x'.repeat(250)} ${apiKey}` }),
    ).toEqual({ query: '[value omitted]' });
  });

  it('does not infer a secret from field labels or generic JWT/public-key examples', () => {
    expect(
      hasIntegrationToolSecret({
        apiKey: 'weather-demo',
        token: 'forecast-token',
        jwt: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJkb2MifQ.signature',
        publicKey:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGenericPublicKeyExample',
        pem: '-----BEGIN PUBLIC KEY-----\npublic key example\n-----END PUBLIC KEY-----',
      }),
    ).toBe(false);
  });

  it('shares neutral masking while allowing different bounded string previews', () => {
    const value = {
      apiKey: 'weather-demo',
      token: 'forecast-token',
      query: `find a document ${openRouterKey}`,
      nested: { note: 'n'.repeat(260) },
    };

    expect(redactIntegrationToolArgs(value)).toEqual({
      apiKey: '[value omitted]',
      token: '[value omitted]',
      query: '[value omitted]',
      nested: { note: `${'n'.repeat(200)}…[truncated]` },
    });
    expect(
      redactIntegrationToolArgs(value, { maxStringLength: 4_000 }),
    ).toMatchObject({ nested: { note: 'n'.repeat(260) } });
    expect(JSON.stringify(redactIntegrationToolArgs(value))).not.toContain(
      openRouterKey,
    );
  });
});
