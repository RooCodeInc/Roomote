import { MCP_INTEGRATIONS } from '@roomote/types';

import {
  AVAILABLE_SETUP_MCP_INTEGRATIONS,
  MCP_SETUP_INTEGRATION_METADATA,
  hydrateSetupMcpRecommendations,
  setupMcpRecommendationIds,
} from '../mcp-self-setup/catalog';

describe('mcp self-setup catalog', () => {
  it('makes every MCP integration recommendable', () => {
    const recommendationIds = new Set(setupMcpRecommendationIds);
    const availableIntegrationIds = new Set(
      AVAILABLE_SETUP_MCP_INTEGRATIONS.map((integration) => integration.id),
    );

    for (const integration of MCP_INTEGRATIONS) {
      expect(recommendationIds.has(integration.id)).toBe(true);
      expect(availableIntegrationIds.has(integration.id)).toBe(true);
    }
  });

  it('requires explicit setup metadata for every MCP integration', () => {
    for (const integration of MCP_INTEGRATIONS) {
      expect(
        Object.hasOwn(MCP_SETUP_INTEGRATION_METADATA, integration.id),
      ).toBe(true);
    }
  });

  it('hydrates derived Snowflake and Grafana recommendations with setup metadata', () => {
    const recommendations = hydrateSetupMcpRecommendations([
      {
        id: 'snowflake',
        rationale: 'Matched Snowflake usage in the repository.',
      },
      {
        id: 'grafana',
        rationale:
          'Matched Grafana dashboards and alerting URLs in the repository.',
      },
    ]);

    expect(recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'snowflake',
          name: 'Snowflake',
          category: 'built_in_integration',
          setupLocation: 'Integrations > Snowflake',
          capabilities: expect.arrayContaining([
            'Inspect Snowflake databases, schemas, and tables',
          ]),
        }),
        expect.objectContaining({
          id: 'grafana',
          name: 'Grafana',
          category: 'built_in_integration',
          setupLocation: 'Integrations > Grafana',
          capabilities: expect.arrayContaining([
            'Inspect Grafana dashboards and dashboard metadata',
          ]),
        }),
      ]),
    );
  });

  it('points manual setup at the page that configures each integration', () => {
    const setupLocations = Object.fromEntries(
      AVAILABLE_SETUP_MCP_INTEGRATIONS.map((integration) => [
        integration.id,
        integration.setupLocation,
      ]),
    );

    expect(setupLocations).toMatchObject({
      github: 'Settings > Source Control > GitHub',
      linear: 'Integrations > Linear',
      sentry: 'Integrations > Sentry',
      slack: 'Settings > Communications > Slack',
    });
    for (const setupLocation of Object.values(setupLocations)) {
      expect(setupLocation).not.toContain('Settings > Integrations');
    }
  });
});
