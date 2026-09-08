import { MCP_INTEGRATIONS } from './mcp-oauth';
import {
  buildIntegrationConnectionPreparation,
  prepareIntegrationConnectionInputSchema,
  sanitizeCustomMcpServerName,
} from './integration-connection';

describe('integration connection preparation', () => {
  it.each(['GitHub', ' SLACK ', 'GitHub.', 'Slack (+)', 'Roomote', 'gbrain'])(
    'does not send reserved fallback %j to custom setup',
    (provider) => {
      const result = buildIntegrationConnectionPreparation(
        { provider },
        'https://roomote.example',
      );
      expect(result).toMatchObject({
        status: 'unsupported',
        validated: false,
        setupKind: 'unsupported',
        setupUrl: 'https://roomote.example/settings/integrations',
      });
      expect(result.guidance).toContain('service-specific setup');
    },
  );

  it.each([
    ['Example_Server v2', 'example_server-v2'],
    ['Example & Co', 'example-co'],
    ['Caf\u00e9 Tools', 'caf-tools'],
    ['***', null],
    ['a'.repeat(80), 'a'.repeat(64)],
  ] as const)(
    'sanitizes %j consistently for custom server names',
    (raw, expected) => {
      expect(sanitizeCustomMcpServerName(raw)).toBe(expected);
    },
  );

  it.each(MCP_INTEGRATIONS)(
    'prefers catalog id and name for $id',
    (integration) => {
      for (const provider of [
        integration.id,
        ` ${integration.name.toUpperCase()} `,
      ]) {
        expect(
          buildIntegrationConnectionPreparation(
            { provider },
            'https://roomote.example',
          ),
        ).toMatchObject({
          status: 'setup_required',
          validated: false,
          integrationId: integration.id,
          setupKind: 'native',
          setupUrl: `https://roomote.example/settings/integrations?highlight=${integration.id}`,
        });
      }
    },
  );

  it('resolves Twitter to native X', () => {
    expect(
      buildIntegrationConnectionPreparation(
        { provider: 'Twitter' },
        'https://roomote.example',
      ).integrationId,
    ).toBe('x');
  });

  it('encodes a custom nonsecret name without inventing a remote endpoint', () => {
    const result = buildIntegrationConnectionPreparation(
      { provider: 'Example & Co' },
      'https://roomote.example/base?token=unused',
    );
    const url = new URL(result.setupUrl);
    expect(url.origin).toBe('https://roomote.example');
    expect(url.pathname).toBe('/settings/integrations');
    expect([...url.searchParams]).toEqual([
      ['connect', 'custom'],
      ['name', 'Example & Co'],
    ]);
    expect(result).toMatchObject({
      status: 'setup_required',
      validated: false,
      integrationId: null,
      setupKind: 'custom',
    });
    expect(result.guidance).toContain('manage_integration_connection');
    expect(result.guidance).toContain('separately scoped coding investigation');
    expect(result.guidance).toContain('never invent an endpoint');
    expect(result.guidance).toContain('find_integration_tools');
  });

  it.each([
    '',
    '  ',
    'https://example.com/mcp',
    '//evil.example',
    'Provider?token=secret',
    'Provider\nAuthorization',
    'sk_secret',
    'a'.repeat(81),
  ])('rejects invalid provider %j', (provider) => {
    expect(
      prepareIntegrationConnectionInputSchema.safeParse({ provider }).success,
    ).toBe(false);
  });

  it.each(['url', 'apiKey', 'token', 'headers'])(
    'rejects additional %s input',
    (key) => {
      expect(
        prepareIntegrationConnectionInputSchema.safeParse({
          provider: 'Example',
          [key]: 'secret',
        }).success,
      ).toBe(false);
    },
  );
});
