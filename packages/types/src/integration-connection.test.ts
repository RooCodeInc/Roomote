import { MCP_INTEGRATIONS } from './mcp-oauth';
import {
  buildIntegrationConnectionPreparation,
  prepareIntegrationConnectionInputSchema,
} from './integration-connection';

describe('integration connection preparation', () => {
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
    expect(result.guidance).toContain('API-only');
    expect(result.guidance).toContain('Never invent an endpoint');
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
