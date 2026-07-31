export type SlackMcpSetupAvailabilityKind =
  | 'curated_oauth'
  | 'admin_configured'
  | 'deployment_env_var'
  | 'linear';

export interface SlackMcpSetupServiceDefinition {
  id: string;
  name: string;
  availabilityKind: SlackMcpSetupAvailabilityKind;
  hostSuffixes: string[];
  excludedHostnames?: string[];
  pathPrefixes?: string[];
  hostRules?: SlackMcpSetupServiceHostRule[];
  requiredDeploymentEnvVars?: string[];
  deploymentSettingsPath: string;
  userSettingsPath: string;
  settingsTargets?: Partial<
    Record<
      | 'deployment_auth_required_admin'
      | 'deployment_auth_required_non_admin'
      | 'deployment_disabled_admin'
      | 'deployment_disabled_non_admin',
      SlackMcpSetupSettingsTarget
    >
  >;
}

export interface SlackMcpSetupServiceHostRule {
  hostSuffix: string;
  pathPrefixes?: string[];
  pathRegexes?: RegExp[];
}

export interface SlackMcpSetupSettingsTarget {
  queryParam: 'highlight' | 'service';
  value: string;
}

const VERCEL_PUBLIC_SITE_ROOT_SEGMENTS = [
  'academy',
  'blog',
  'changelog',
  'community',
  'contact',
  'customers',
  'docs',
  'enterprise',
  'events',
  'experts',
  'guides',
  'integrations',
  'legal',
  'marketplace',
  'pricing',
  'privacy',
  'resources',
  'security',
  'solutions',
  'startups',
  'support',
  'templates',
] as const;

const VERCEL_PUBLIC_SITE_ROOT_SEGMENT_PATTERN =
  VERCEL_PUBLIC_SITE_ROOT_SEGMENTS.join('|');

const VERCEL_PROJECT_ROOT_PATH_REGEX = new RegExp(
  `^/(?!(?:${VERCEL_PUBLIC_SITE_ROOT_SEGMENT_PATTERN})(?:/|$))[^/]+/[^/]+/?$`,
);

const VERCEL_PROJECT_TAB_PATH_REGEX = new RegExp(
  `^/(?!(?:${VERCEL_PUBLIC_SITE_ROOT_SEGMENT_PATTERN})(?:/|$))[^/]+/[^/]+/(?:analytics|deployments|domains|functions|logs|observability|settings|storage|usage)(?:/|$)`,
);

// Zero product surfaces: capability pages (/c/<id>), the service directory
// (/browse), and the wallet/profile page. The bare homepage also matches — a
// pasted zero.xyz root link still reads as "about Zero" — but deep marketing
// pages (/faq, /security, /getlisted, ...) do not.
const ZERO_APP_PATH_REGEX = /^\/(?:c|browse|profile)(?:\/|$)/;
const HOMEPAGE_PATH_REGEX = /^\/$/;

export const SLACK_MCP_SETUP_SERVICES: SlackMcpSetupServiceDefinition[] = [
  {
    id: 'asana',
    name: 'Asana',
    availabilityKind: 'admin_configured',
    hostSuffixes: ['app.asana.com'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'linear',
    name: 'Linear',
    availabilityKind: 'linear',
    hostSuffixes: ['linear.app'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'monday',
    name: 'monday.com',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['monday.com'],
    excludedHostnames: [
      'monday.com',
      'www.monday.com',
      'api.monday.com',
      'auth.monday.com',
      'developer.monday.com',
      'mcp.monday.com',
      'support.monday.com',
      'view.monday.com',
    ],
    pathPrefixes: ['/boards/'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'notion',
    name: 'Notion',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['notion.so', 'notion.site'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'jira',
    name: 'Jira',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['atlassian.net'],
    pathPrefixes: ['/browse/', '/issues/', '/jira/', '/projects/', '/secure/'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['sentry.io'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
    settingsTargets: {
      deployment_auth_required_admin: {
        queryParam: 'highlight',
        value: 'sentry-mcp',
      },
      deployment_auth_required_non_admin: {
        queryParam: 'highlight',
        value: 'sentry-mcp',
      },
      deployment_disabled_admin: {
        queryParam: 'highlight',
        value: 'sentry-mcp',
      },
      deployment_disabled_non_admin: {
        queryParam: 'highlight',
        value: 'sentry-mcp',
      },
    },
  },
  {
    id: 'pylon',
    name: 'Pylon',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['app.usepylon.com'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'posthog',
    name: 'PostHog',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['posthog.com'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'neon',
    name: 'Neon',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['neon.tech'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['supabase.com'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'betterstack',
    name: 'Better Stack',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['betterstack.com'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'railway',
    name: 'Railway',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['railway.app', 'railway.com'],
    pathPrefixes: ['/project'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'resend',
    name: 'Resend',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['resend.com'],
    pathPrefixes: [
      '/api-keys',
      '/audiences',
      '/automations',
      '/broadcasts',
      '/contacts',
      '/domains',
      '/emails',
      '/logs',
      '/segments',
      '/settings',
      '/templates',
      '/topics',
      '/webhooks',
    ],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    availabilityKind: 'admin_configured',
    hostSuffixes: ['vercel.app', 'vercel.com'],
    hostRules: [
      {
        hostSuffix: 'vercel.app',
      },
      {
        hostSuffix: 'vercel.com',
        pathRegexes: [
          VERCEL_PROJECT_ROOT_PATH_REGEX,
          VERCEL_PROJECT_TAB_PATH_REGEX,
        ],
      },
    ],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['braintrust.dev'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'supermemory',
    name: 'Supermemory',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['app.supermemory.ai', 'console.supermemory.ai'],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'zero',
    name: 'Zero',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['zero.xyz', 'withzero.ai'],
    hostRules: [
      {
        hostSuffix: 'mcp.zero.xyz',
      },
      {
        hostSuffix: 'zero.xyz',
        pathRegexes: [HOMEPAGE_PATH_REGEX, ZERO_APP_PATH_REGEX],
      },
      {
        hostSuffix: 'withzero.ai',
        pathRegexes: [HOMEPAGE_PATH_REGEX],
      },
    ],
    deploymentSettingsPath: '/settings/integrations',
    userSettingsPath: '/settings/personal',
  },
];

export function getSlackMcpSetupServiceDefinition(
  id: string,
): SlackMcpSetupServiceDefinition | undefined {
  return SLACK_MCP_SETUP_SERVICES.find((service) => service.id === id);
}
