import { MCP_INTEGRATIONS, type McpIntegration } from '@roomote/types';

import type {
  CurrentMcpConfig,
  McpRecommendation,
  McpRecommendationCategory,
} from './types';

const INTEGRATIONS_SETTINGS_PATH = 'Settings > Integrations';
const SOURCE_CONTROL_SETTINGS_PATH = 'Settings > Environments > Source control';

export type AvailableSetupMcpIntegration = Omit<
  McpRecommendation,
  'priority' | 'rationale'
>;

type SetupMcpIntegrationMetadata = {
  capabilities: string[];
  setupLocation?: string;
  category?: McpRecommendationCategory;
};

function getIntegrationSettingsPath(name: string): string {
  return `${INTEGRATIONS_SETTINGS_PATH} > ${name}`;
}

function getDefaultSetupMcpIntegrationMetadata(
  integration: Pick<McpIntegration, 'name'>,
): Required<SetupMcpIntegrationMetadata> {
  return {
    category: 'built_in_integration',
    capabilities: [`Use ${integration.name} directly from Roomote tasks`],
    setupLocation: getIntegrationSettingsPath(integration.name),
  };
}

export const MCP_SETUP_INTEGRATION_METADATA: Record<
  string,
  SetupMcpIntegrationMetadata
> = {
  asana: {
    capabilities: [
      'Inspect Asana workspaces, projects, and tasks',
      'Read task comments and team context during implementation work',
      'Pull shared project state into debugging and planning tasks',
    ],
  },
  grafana: {
    capabilities: [
      'Inspect Grafana dashboards and dashboard metadata',
      'Review alert rules plus current alert instances and states',
      'Pull data source and annotation context into investigations',
    ],
  },
  pylon: {
    capabilities: [
      'Search customer issues and fetch full issue details',
      'Read issue message history for support investigations',
      'Look up accounts while debugging customer-impacting problems',
    ],
  },
  posthog: {
    capabilities: [
      'Query product analytics and funnels',
      'Inspect feature flags and experiments',
      'Pull product usage context into investigations',
    ],
  },
  notion: {
    capabilities: [
      'Read Notion pages and databases',
      'Pull requirements and product docs into task context',
      'Answer questions against internal documentation',
    ],
  },
  jira: {
    capabilities: [
      'Read Jira issues and linked metadata',
      'Search issues with JQL from the task',
      'Use project and workflow context while implementing work',
    ],
  },
  linear: {
    category: 'org_integration',
    capabilities: [
      'Look up issues, cycles, projects, and roadmaps',
      'Update issue status from tasks',
      'Use issue context when implementing or reviewing work',
    ],
  },
  monday: {
    capabilities: [
      'Inspect monday.com boards, groups, columns, and items',
      'Read item updates, WorkDocs, and workspace context',
      'Review automations, forms, meetings, and sprint data',
    ],
  },
  sentry: {
    capabilities: [
      'Inspect Sentry issues and project context through MCP',
      'Support scheduled read-only Sentry triage automation through MCP',
      'Use the same workspace connection for Sentry investigations and follow-up fixes',
    ],
  },
  neon: {
    capabilities: [
      'Inspect Neon databases and branches',
      'Understand Postgres schema directly from the task',
      'Debug database-backed features faster',
    ],
  },
  supabase: {
    capabilities: [
      'Inspect Supabase Postgres schema',
      'Use platform context when debugging auth and data flows',
      'Answer database questions without leaving the task',
    ],
  },
  snowflake: {
    capabilities: [
      'Inspect Snowflake databases, schemas, and tables',
      'Run warehouse-backed investigations from the active task',
      'Use data warehouse context while debugging analytics and ETL flows',
    ],
  },
  betterstack: {
    capabilities: [
      'Inspect uptime and incident history',
      'Query logs and telemetry dashboards',
      'Cross-reference alerts with code changes',
    ],
  },
  railway: {
    capabilities: [
      'Confirm which Railway account is connected',
      'List Railway projects available to the workspace',
      'Inspect the services inside a Railway project',
    ],
  },
  resend: {
    capabilities: [
      'Inspect sent and received email delivery details',
      'Review domains, logs, templates, contacts, and broadcasts',
      'Opt in to email sending, credential creation, automation triggers, and contact mutations when needed',
    ],
  },
  vercel: {
    capabilities: [
      'Inspect Vercel teams and projects',
      'Review recent deployments plus build and runtime logs',
      'Check domain availability and pricing while planning changes',
    ],
  },
  braintrust: {
    capabilities: [
      'Review prompt versions and experiments',
      'Inspect evaluation runs and scores',
      'Tie AI regressions back to code and prompt changes',
    ],
  },
  granola: {
    capabilities: [
      'Browse workspace meeting notes for relevant discussions and decisions',
      'Read meeting details and transcripts through a deployment API key',
      'Keep access read-only and limited by the Granola key configuration',
    ],
  },
  supermemory: {
    capabilities: [
      'Save important decisions and context as shared memories during tasks',
      'Recall relevant memories from earlier tasks while working',
      'Build persistent deployment-wide memory across tasks over time',
    ],
  },
  zero: {
    capabilities: [
      'Search free external capability catalog when native tools fall short',
      'Call paid APIs through the zero CLI using the workspace Zero wallet',
      'Authenticate and fund Zero through the MCP connector when needed',
    ],
  },
};

const MANUAL_SETUP_MCP_INTEGRATIONS: AvailableSetupMcpIntegration[] = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'org_integration',
    description:
      'Install the GitHub integration so agents can inspect PRs, issues, and repository context beyond the checked-out files.',
    capabilities: [
      'Inspect pull requests and issues',
      'Answer questions about repository history and review state',
      'Create or update PRs from tasks',
    ],
    setupLocation: `${SOURCE_CONTROL_SETTINGS_PATH} > GitHub`,
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'org_integration',
    description:
      'Enable the Linear org integration so agents can pull issue, project, and roadmap context directly into tasks.',
    capabilities: [
      'Look up issues, cycles, projects, and roadmaps',
      'Update issue status from tasks',
      'Use issue context when implementing or reviewing work',
    ],
    setupLocation: getIntegrationSettingsPath('Linear'),
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'built_in_integration',
    description:
      'Connect Sentry to bring Sentry issue and project context into tasks.',
    capabilities: [
      'Inspect Sentry issues and project context through MCP',
      'Support scheduled read-only Sentry triage automation through MCP',
      'Use the same workspace connection for Sentry investigations and follow-up fixes',
    ],
    setupLocation: getIntegrationSettingsPath('Sentry'),
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'org_integration',
    description:
      'Install the Slack integration so the team can launch and continue tasks directly from Slack threads.',
    capabilities: [
      'Start tasks from mentions and DMs',
      'Post task updates back into Slack',
      'Keep implementation work connected to the originating thread',
    ],
    setupLocation: getIntegrationSettingsPath('Slack'),
  },
];

function buildAvailableSetupMcpIntegration(
  integration: McpIntegration,
): AvailableSetupMcpIntegration {
  const metadata = {
    ...getDefaultSetupMcpIntegrationMetadata(integration),
    ...MCP_SETUP_INTEGRATION_METADATA[integration.id],
  };

  return {
    id: integration.id,
    name: integration.name,
    description: integration.description,
    category: metadata.category,
    capabilities: metadata.capabilities,
    setupLocation: metadata.setupLocation,
  };
}

export const AVAILABLE_SETUP_MCP_INTEGRATIONS: AvailableSetupMcpIntegration[] =
  [
    ...MCP_INTEGRATIONS.filter(
      (integration) => integration.id !== 'sentry',
    ).map(buildAvailableSetupMcpIntegration),
    ...MANUAL_SETUP_MCP_INTEGRATIONS,
  ];

export const setupMcpRecommendationIds = AVAILABLE_SETUP_MCP_INTEGRATIONS.map(
  (integration) => integration.id,
);

export type SetupMcpRecommendationId = AvailableSetupMcpIntegration['id'];

const setupMcpRecommendationIdSet = new Set(setupMcpRecommendationIds);

export function isSetupMcpRecommendationId(
  value: string,
): value is SetupMcpRecommendationId {
  return setupMcpRecommendationIdSet.has(value);
}

const availableSetupMcpIntegrationsById = new Map(
  AVAILABLE_SETUP_MCP_INTEGRATIONS.map((integration) => [
    integration.id,
    integration,
  ]),
);

export function normalizeEnabledSetupMcpIntegrationIds(
  currentConfig?: CurrentMcpConfig,
): string[] {
  return [
    ...new Set(
      [
        ...(currentConfig?.enabledIntegrationIds ?? []),
        ...(currentConfig?.configuredCustomServerIds ?? []),
        ...(currentConfig?.configuredWorkspaceServerIds ?? []),
      ]
        .map((integrationId) => integrationId.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function getPriorityForRecommendationPosition(
  index: number,
): McpRecommendation['priority'] {
  if (index === 0) {
    return 'high';
  }

  if (index < 3) {
    return 'medium';
  }

  return 'low';
}

export function hydrateSetupMcpRecommendations(
  recommendations: Array<{
    id: SetupMcpRecommendationId;
    rationale: string;
  }>,
): McpRecommendation[] {
  const seenRecommendationIds = new Set<string>();

  return recommendations.flatMap((recommendation, index) => {
    const recommendationId = recommendation.id.trim().toLowerCase();

    if (seenRecommendationIds.has(recommendationId)) {
      return [];
    }

    seenRecommendationIds.add(recommendationId);

    const integration = availableSetupMcpIntegrationsById.get(recommendationId);

    if (!integration) {
      return [];
    }

    return [
      {
        ...integration,
        priority: getPriorityForRecommendationPosition(index),
        rationale: recommendation.rationale.trim(),
      },
    ];
  });
}
