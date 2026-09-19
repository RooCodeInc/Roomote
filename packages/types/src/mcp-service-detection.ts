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

// X app surfaces that signal "this task is about X content": post permalinks
// (/<username>/status/<id>), search/explore, and /i/ product paths (lists,
// communities, spaces). Bare profile URLs are one path segment and would
// swallow unrelated x.com pages, so they deliberately do not match. Matched
// against a lowercased pathname.
const X_POST_PATH_REGEX = /^\/[a-z0-9_]{1,15}\/status\/\d+/;
const X_APP_PATH_REGEX =
  /^\/(?:search|explore)(?:\/|$)|^\/i\/(?:lists|communities|spaces)\//;

const BUILDKITE_PUBLIC_ROOT_SEGMENTS = [
  'about',
  'blog',
  'changelog',
  'community',
  'customers',
  'docs',
  'features',
  'legal',
  'pricing',
  'resources',
  'security',
  'support',
] as const;
const BUILDKITE_ORGANIZATION_PATH_REGEX = new RegExp(
  `^/(?!(?:${BUILDKITE_PUBLIC_ROOT_SEGMENTS.join('|')})(?:/|$))[^/]+(?:/|$)`,
);

export const SLACK_MCP_SETUP_SERVICES: SlackMcpSetupServiceDefinition[] = [
  {
    id: 'buildkite',
    name: 'Buildkite',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['buildkite.com'],
    excludedHostnames: [
      'www.buildkite.com',
      'api.buildkite.com',
      'mcp.buildkite.com',
    ],
    hostRules: [
      {
        hostSuffix: 'buildkite.com',
        pathRegexes: [BUILDKITE_ORGANIZATION_PATH_REGEX],
      },
    ],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['dash.cloudflare.com'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'asana',
    name: 'Asana',
    availabilityKind: 'admin_configured',
    hostSuffixes: ['app.asana.com'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'linear',
    name: 'Linear',
    availabilityKind: 'linear',
    hostSuffixes: ['linear.app'],
    deploymentSettingsPath: '/integrations',
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
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'notion',
    name: 'Notion',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['notion.so', 'notion.site'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'jira',
    name: 'Jira',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['atlassian.net'],
    pathPrefixes: ['/browse/', '/issues/', '/jira/', '/projects/', '/secure/'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['sentry.io'],
    deploymentSettingsPath: '/integrations',
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
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'posthog',
    name: 'PostHog',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['posthog.com'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'neon',
    name: 'Neon',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['neon.tech'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['supabase.com'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'betterstack',
    name: 'Better Stack',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['betterstack.com'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'railway',
    name: 'Railway',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['railway.app', 'railway.com'],
    pathPrefixes: ['/project'],
    deploymentSettingsPath: '/integrations',
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
    deploymentSettingsPath: '/integrations',
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
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['braintrust.dev'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'granola',
    name: 'Granola',
    availabilityKind: 'admin_configured',
    hostSuffixes: ['notes.granola.ai'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'exa',
    name: 'Exa',
    availabilityKind: 'admin_configured',
    hostSuffixes: ['dashboard.exa.ai'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'supermemory',
    name: 'Supermemory',
    availabilityKind: 'curated_oauth',
    hostSuffixes: ['app.supermemory.ai', 'console.supermemory.ai'],
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
  {
    id: 'x',
    name: 'X',
    availabilityKind: 'admin_configured',
    hostSuffixes: ['x.com', 'twitter.com'],
    hostRules: [
      {
        hostSuffix: 'x.com',
        pathRegexes: [X_POST_PATH_REGEX, X_APP_PATH_REGEX],
      },
      {
        hostSuffix: 'twitter.com',
        pathRegexes: [X_POST_PATH_REGEX, X_APP_PATH_REGEX],
      },
    ],
    deploymentSettingsPath: '/integrations',
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
    deploymentSettingsPath: '/integrations',
    userSettingsPath: '/settings/personal',
  },
];

export function getSlackMcpSetupServiceDefinition(
  id: string,
): SlackMcpSetupServiceDefinition | undefined {
  return SLACK_MCP_SETUP_SERVICES.find((service) => service.id === id);
}

function hostMatchesService(hostname: string, suffix: string): boolean {
  const normalizedSuffix = suffix.toLowerCase();
  return (
    hostname === normalizedSuffix || hostname.endsWith(`.${normalizedSuffix}`)
  );
}

function pathMatchesServiceRule(
  pathname: string,
  rule: Pick<SlackMcpSetupServiceDefinition, 'pathPrefixes'> & {
    pathRegexes?: RegExp[];
  },
): boolean {
  if (
    rule.pathPrefixes?.some((prefix) =>
      pathname.startsWith(prefix.toLowerCase()),
    )
  ) {
    return true;
  }

  if (rule.pathRegexes?.some((pattern) => pattern.test(pathname))) {
    return true;
  }

  return !rule.pathPrefixes?.length && !rule.pathRegexes?.length;
}

export function matchSlackMcpSetupServiceUrl(
  rawUrl: string,
): SlackMcpSetupServiceDefinition | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.startsWith('www.') ? `https://${rawUrl}` : rawUrl);
  } catch {
    return undefined;
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  for (const service of SLACK_MCP_SETUP_SERVICES) {
    if (
      service.excludedHostnames?.some(
        (excluded) => excluded.toLowerCase() === hostname,
      )
    ) {
      continue;
    }

    if (service.hostRules?.length) {
      if (
        service.hostRules.some(
          (rule) =>
            hostMatchesService(hostname, rule.hostSuffix) &&
            pathMatchesServiceRule(pathname, rule),
        )
      ) {
        return service;
      }
      continue;
    }

    if (
      service.hostSuffixes.some((suffix) =>
        hostMatchesService(hostname, suffix),
      ) &&
      pathMatchesServiceRule(pathname, service)
    ) {
      return service;
    }
  }

  return undefined;
}

function stripTrailingUrlPunctuation(value: string): string {
  let end = value.length;
  while (end > 0) {
    const character = value[end - 1];
    if (
      character === ',' ||
      character === '.' ||
      character === '!' ||
      character === '?'
    ) {
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

export function findSlackMcpSetupServicesInText(
  text: string,
): SlackMcpSetupServiceDefinition[] {
  const services = new Map<string, SlackMcpSetupServiceDefinition>();
  const urlPattern = /(?:https?:\/\/|www\.)[^\s<>()|]+/giu;

  for (const match of text.matchAll(urlPattern)) {
    const candidate = stripTrailingUrlPunctuation(match[0]);
    const service = matchSlackMcpSetupServiceUrl(candidate);
    if (service) {
      services.set(service.id, service);
    }
  }

  return [...services.values()];
}
