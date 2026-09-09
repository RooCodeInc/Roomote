import { MCP_INTEGRATIONS } from './mcp-oauth';
import { communicationProviders } from './communication';
import { sourceControlProviders } from './source-control';
import { computeProviders } from './compute-providers/compute-provider';
import { SETUP_MODEL_PROVIDER_IDS } from './model-provider-config';
import {
  ADMIN_INTEGRATION_ORDER,
  COMMUNICATION_PROVIDER_ORDER,
  SOURCE_CONTROL_PROVIDER_ORDER,
  SETUP_INTEGRATION_CATEGORIES,
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATION_EXCLUDED_PROVIDER_IDS,
  getSetupIntegrationCategories,
  isSetupIntegrationDiscoveryQuestionId,
  matchSetupIntegrationAnswers,
} from './onboarding-integrations';

describe('setup integration discovery catalog', () => {
  it('excludes the four provider categories, retaining the distinct Vercel connector and homepage priority', () => {
    const excluded = new Set<string>([
      ...sourceControlProviders,
      ...communicationProviders,
      ...computeProviders,
      ...SETUP_MODEL_PROVIDER_IDS.filter((id) => id !== 'vercel'),
    ]);
    expect(SETUP_INTEGRATION_EXCLUDED_PROVIDER_IDS).toEqual(excluded);
    const ids = SETUP_INTEGRATIONS.map(({ id }) => id);
    expect(ids).toEqual(
      [
        ...new Set([
          ...ADMIN_INTEGRATION_ORDER,
          ...MCP_INTEGRATIONS.map(({ id }) => id),
        ]),
      ].filter(
        (id) =>
          !excluded.has(id) &&
          MCP_INTEGRATIONS.some((integration) => integration.id === id),
      ),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of excluded) expect(ids).not.toContain(id);
    expect(ids).toContain('vercel');
    expect(SETUP_INTEGRATION_EXCLUDED_PROVIDER_IDS.has('microsoft')).toBe(
      false,
    );
    expect(
      MCP_INTEGRATIONS.filter(({ id }) =>
        (SETUP_MODEL_PROVIDER_IDS as readonly string[]).includes(id),
      ).map(({ id }) => id),
    ).toEqual(['vercel']);
    expect(ids).toEqual(
      expect.arrayContaining(['railway', 'supabase', 'granola']),
    );
    for (const integration of SETUP_INTEGRATIONS) {
      expect(integration.kind).toBe('mcp');
      expect(integration.name).toBe(
        MCP_INTEGRATIONS.find(({ id }) => id === integration.id)?.name,
      );
    }
    expect(SETUP_INTEGRATION_CATEGORIES.map(({ id }) => id)).toEqual([
      'documents',
      'monitoring',
      'project-tracking',
    ]);
    for (const category of SETUP_INTEGRATION_CATEGORIES) {
      expect(category.integrationIds.length).toBeGreaterThan(0);
      for (const id of category.integrationIds) expect(ids).toContain(id);
    }
  });

  it('preserves the separate homepage provider controls and ordering', () => {
    expect(COMMUNICATION_PROVIDER_ORDER).toEqual([
      'slack',
      'microsoft',
      'telegram',
      'discord',
    ]);
    expect(SOURCE_CONTROL_PROVIDER_ORDER).toEqual([
      'github',
      'gitlab',
      'gitea',
      'bitbucket',
      'ado',
    ]);
    expect(ADMIN_INTEGRATION_ORDER).toContain('vercel');
  });

  it('derives category order from eligible first appearances, not provider entries', () => {
    const categories = getSetupIntegrationCategories([
      'slack',
      'vercel',
      'asana',
      'grafana',
      'linear',
      'microsoft',
      'notion',
      ...ADMIN_INTEGRATION_ORDER,
    ]);
    expect(categories.map(({ id }) => id)).toEqual([
      'project-tracking',
      'monitoring',
      'documents',
    ]);
    expect(
      categories.find(({ id }) => id === 'project-tracking')?.integrationIds,
    ).toEqual(['asana', 'linear', 'jira', 'monday']);
    expect(
      categories.flatMap(({ integrationIds }) => integrationIds),
    ).not.toContain('vercel');
  });

  it('matches all eligible catalog names and IDs globally', () => {
    for (const category of SETUP_INTEGRATION_CATEGORIES) {
      expect(
        matchSetupIntegrationAnswers({
          [category.id]: {
            answers: SETUP_INTEGRATIONS.flatMap(({ id, name }) => [id, name]),
          },
        }),
      ).toEqual({
        answeredCategoryIds: [category.id],
        matchedIntegrationIds: SETUP_INTEGRATIONS.map(({ id }) => id),
        unsupportedTools: [],
      });
    }
  });

  it('never restores providers from legacy answers or model-extracted hints', () => {
    expect(
      matchSetupIntegrationAnswers({
        'setup-tools-communication': {
          answers: ['slack', 'Discord', 'Notion'],
        },
        communication: { answers: ['Microsoft Teams'] },
        documents: {
          answers: [
            'Vercel',
            'slack',
            'Microsoft Teams',
            'github',
            'Granola',
            'Google Docs',
          ],
        },
      }),
    ).toEqual({
      answeredCategoryIds: ['documents'],
      matchedIntegrationIds: ['vercel', 'granola'],
      unsupportedTools: ['Google Docs'],
    });
    expect(
      isSetupIntegrationDiscoveryQuestionId('setup-tools-communication'),
    ).toBe(true);
    expect(isSetupIntegrationDiscoveryQuestionId('setup-tools-documents')).toBe(
      true,
    );
    expect(isSetupIntegrationDiscoveryQuestionId('unrelated')).toBe(false);
  });

  it('matches whole names only and deduplicates in homepage order', () => {
    expect(
      matchSetupIntegrationAnswers({
        documents: { answers: ['Notion Calendar', 'notion', 'notion'] },
        monitoring: { answers: ['Grafana, Sentry; PostHog\nDatadog'] },
        'project-tracking': { answers: ['asana', 'linear', 'none', 'skip'] },
        unrelated: { answers: ['jira'] },
      }),
    ).toEqual({
      answeredCategoryIds: ['documents', 'monitoring', 'project-tracking'],
      matchedIntegrationIds: [
        'notion',
        'sentry',
        'linear',
        'posthog',
        'grafana',
        'asana',
      ],
      unsupportedTools: ['Notion Calendar', 'Datadog'],
    });
    expect(
      matchSetupIntegrationAnswers({
        documents: { answers: ['We do not use Notion'] },
      }).matchedIntegrationIds,
    ).toEqual([]);
  });
});
