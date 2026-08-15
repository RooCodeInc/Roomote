import { PRODUCT_NAME } from './constants';

/**
 * MCP OAuth Configuration Types
 *
 * MCP OAuth uses dynamic client registration (RFC 7591) instead of static provider configs.
 * Each MCP connection can have its own OAuth configuration discovered from the MCP server.
 */

/**
 * Standard OAuth 2.1 token response
 */
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number; // Seconds until expiration
  token_type?: string; // Usually "Bearer"
  scope?: string; // Space-separated scopes
}

/**
 * OAuth client information from dynamic registration (RFC 7591)
 */
export type OAuthTokenEndpointAuthMethod =
  | 'none'
  | 'client_secret_post'
  | 'client_secret_basic';

export interface OAuthClientInformation {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: OAuthTokenEndpointAuthMethod;
}

/**
 * OAuth client metadata for dynamic registration (RFC 7591)
 */
export interface OAuthClientMetadata {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: OAuthTokenEndpointAuthMethod;
  scope?: string;
}

/**
 * OAuth authorization server metadata (RFC 8414)
 * Discovered from /.well-known/oauth-authorization-server
 */
export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  response_types_supported: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/**
 * OAuth 2 protected resource metadata (RFC 9728)
 * Discovered from /.well-known/oauth-protected-resource
 */
export interface OAuthProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

/**
 * OAuth client credentials from dynamic registration.
 */
export interface McpConnectionOAuthConfig {
  type: 'oauth_client';
  registered_redirect_uri: string;
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: OAuthTokenEndpointAuthMethod;
  linearOrganizationId?: string;
  linearOrganizationName?: string | null;
  linearOrganizationUrlKey?: string | null;
  appUserId?: string;
  linearUserId?: string;
}

/**
 * Organization-scoped Snowflake connection config stored in mcpConnections.authConfig.
 *
 * Secrets are expected to be encrypted before persistence. The current backend
 * accepts both encrypted and plaintext secret values so a later admin flow can
 * migrate the write path without breaking existing rows.
 */
export interface McpConnectionSnowflakeConfig {
  type: 'snowflake';
  account: string;
  username: string;
  role: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  encryptedPassword?: string;
  encryptedPrivateKey?: string;
  encryptedPrivateKeyPassphrase?: string;
  allowedStatementTypes?: string[];
}

/**
 * Organization-scoped Asana connection config stored in mcpConnections.authConfig.
 *
 * The bearer token is expected to be encrypted before persistence.
 */
export interface McpConnectionAsanaConfig {
  type: 'asana';
  encryptedToken: string;
}

/**
 * Deployment-scoped Granola connection config stored in mcpConnections.authConfig.
 *
 * The API key is expected to be encrypted before persistence.
 */
export interface McpConnectionGranolaConfig {
  type: 'granola';
  encryptedApiKey: string;
}

/**
 * Deployment-scoped ElevenLabs connection config stored in
 * mcpConnections.authConfig.
 *
 * Credential-only: consumed by the control-plane narration TTS endpoint
 * (/api/tts) and deliberately excluded from agent MCP config delivery — the
 * key never reaches a task sandbox. The API key is expected to be encrypted
 * before persistence; the voice id is plain configuration.
 */
export interface McpConnectionElevenLabsConfig {
  type: 'elevenlabs';
  encryptedApiKey: string;
  voiceId: string;
}

/**
 * Deployment-scoped X connection config stored in mcpConnections.authConfig.
 *
 * Holds an X API app-only bearer token that the integration proxy forwards to
 * X's hosted MCP server. App-only tokens are read-only by construction: X
 * requires user-context OAuth for every mutating endpoint, which this
 * integration deliberately does not support. The token is expected to be
 * encrypted before persistence.
 */
export interface McpConnectionXConfig {
  type: 'x';
  encryptedBearerToken: string;
}

/**
 * Organization-scoped Vercel connection config stored in mcpConnections.authConfig.
 *
 * The bearer token is expected to be encrypted before persistence.
 */
export interface McpConnectionVercelConfig {
  type: 'vercel';
  encryptedAccessToken: string;
  defaultTeamIdOrSlug?: string;
}

/**
 * Organization-scoped Grafana connection config stored in mcpConnections.authConfig.
 *
 * The base URL points at the shared Grafana instance. The service account token
 * is expected to be encrypted before persistence.
 */
export interface McpConnectionGrafanaConfig {
  type: 'grafana';
  baseUrl: string;
  encryptedServiceAccountToken: string;
}

/**
 * Deployment-scoped Brain (gbrain) connection config stored in
 * mcpConnections.authConfig. The URL points at the deployment-hosted gbrain
 * service (typically deployment-internal).
 *
 * Provisioned automatically at connect time: the admin supplies gbrain's
 * bootstrap token once (never persisted), and Roomote registers three OAuth
 * clients via gbrain's admin API. Scopes are enforced server-side by gbrain:
 * the agent client is `read`-scoped (structurally incapable of mutation; the
 * proxy's tool allowlist is defense-in-depth on top), and the ingest client
 * carries `write` for the server-side ingestion worker only. A third,
 * admin-scoped maintenance client is held only by the scheduler, which uses
 * it to enqueue the built-in nightly maintenance cycle. Secrets are
 * encrypted before persistence; short-lived access tokens are minted on
 * demand via the client_credentials grant. R_GBRAIN_* env, when set,
 * overrides this config entirely (operator-managed deployments, static
 * bearer tokens).
 */
export interface McpConnectionGbrainConfig {
  type: 'gbrain';
  url: string;
  agentClientId: string;
  encryptedAgentClientSecret: string;
  ingestClientId: string;
  encryptedIngestClientSecret: string;
  maintenanceClientId: string;
  encryptedMaintenanceClientSecret: string;
}

/**
 * Union of all shapes stored in mcpConnections.authConfig.
 *
 * - McpConnectionOAuthConfig: completed OAuth dynamic registration
 * - McpConnectionSnowflakeConfig: admin-managed Snowflake credentials
 * - Record<string, never>: pending OAuth (empty object before registration)
 */
export type McpConnectionAuthConfig =
  | McpConnectionOAuthConfig
  | McpConnectionSnowflakeConfig
  | McpConnectionAsanaConfig
  | McpConnectionGranolaConfig
  | McpConnectionElevenLabsConfig
  | McpConnectionVercelConfig
  | McpConnectionGrafanaConfig
  | McpConnectionGbrainConfig
  | McpConnectionXConfig
  | Record<string, never>;

export type McpConnectionRole =
  | 'default'
  | 'linear_org_install'
  | 'linear_user_link';

export const LINEAR_APP_OAUTH_SCOPES = [
  'read',
  'write',
  'app:assignable',
  'app:mentionable',
] as const;

export const MONDAY_MCP_READ_ONLY_OAUTH_SCOPES = [
  'account:read',
  'assets:read',
  'boards:read',
  'docs:read',
  'me:read',
  'tags:read',
  'teams:read',
  'updates:read',
  'users:read',
  'workspaces:read',
] as const;

/**
 * MCP Server Configuration
 * This is what gets written to .roomote/mcp.json in the workspace
 */
export interface McpServerConfig {
  type: 'stdio' | 'sse' | 'streamable-http';

  // For streamable-http and sse
  url?: string;
  headers?: Record<string, string>;

  // For stdio
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;

  // Common settings
  disabled?: boolean;
  timeout?: number;
  alwaysAllow?: string[];
  disabledTools?: string[];
  watchPaths?: string[];
}

/**
 * PKCE (Proof Key for Code Exchange) parameters
 * Required for OAuth 2.1 authorization code flow
 */
export interface PkceParams {
  /** Code verifier (stored client-side) */
  codeVerifier: string;

  /** Code challenge (sent to authorization server) */
  codeChallenge: string;

  /** Code challenge method (always S256 for OAuth 2.1) */
  codeChallengeMethod: 'S256';
}

export type LinkedAccountSetup = {
  text: string;
  docsUrl?: string;
};

export type McpIntegrationOauthScopeMode = 'all' | 'read-only';
export type McpIntegrationConnectionMode = 'oauth' | 'admin_configured';
/**
 * - `upstream_proxy`: tools come from a remote MCP server reached through the
 *   Roomote proxy.
 * - `native`: tools come from a Roomote-implemented MCP handler.
 * - `credential_only`: the integration stores admin-configured credentials
 *   consumed by control-plane features; it exposes no MCP tools to agents
 *   and is never delivered to task sandboxes.
 */
export type McpIntegrationServerMode =
  | 'upstream_proxy'
  | 'native'
  | 'credential_only';

export type McpIntegrationOAuthClientEnv = {
  clientIdEnv: string;
  clientSecretEnv?: string;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
};

export type McpIntegrationOAuthEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
};

export type McpIntegrationAuthorizationParameter = {
  name: string;
  value: string;
};

export type McpIntegration = {
  id: string;
  name: string;
  url?: string;
  description: string;
  icon: string;
  /**
   * Optional agent-facing usage guidance. When this integration's MCP server
   * is attached to a task, the worker injects this text into the agent's
   * instruction files so the model knows when to reach for the integration's
   * tools instead of relying on tool descriptions alone.
   */
  instructions?: string;
  linkedAccountSetup?: LinkedAccountSetup;
  connectionScope?: 'user' | 'deployment';
  authorizationParameters?: McpIntegrationAuthorizationParameter[];
  oauthClientEnv?: McpIntegrationOAuthClientEnv;
  oauthEndpoints?: McpIntegrationOAuthEndpoints;
  oauthScopes?: string[];
  oauthScopeSeparator?: ' ' | ',';
  oauthScopeMode?: McpIntegrationOauthScopeMode;
  connectionMode?: McpIntegrationConnectionMode;
  serverMode?: McpIntegrationServerMode;
  defaultDisabledTools?: string[];
};

export const RESEND_DEFAULT_DISABLED_TOOL_NAMES = [
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
] as const;

export const MCP_INTEGRATIONS: McpIntegration[] = [
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    description: `Access your Notion pages, databases, and content within ${PRODUCT_NAME} tasks`,
    icon: 'notion',
  },
  {
    id: 'jira',
    name: 'Jira',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    description: `Access Jira issues, projects, workflows, and JQL search from ${PRODUCT_NAME} tasks`,
    icon: 'jira',
    connectionScope: 'deployment',
    oauthScopes: [
      'read:me',
      'read:account',
      'offline_access',
      'read:jira-work',
      'search:jira-work',
    ],
  },
  {
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    description: `Enable Linear so this deployment can route issue context and task entry through it.`,
    icon: 'linear',
    connectionScope: 'deployment',
    connectionMode: 'oauth',
    serverMode: 'upstream_proxy',
    oauthClientEnv: {
      clientIdEnv: 'R_LINEAR_CLIENT_ID',
      clientSecretEnv: 'R_LINEAR_CLIENT_SECRET',
      tokenEndpointAuthMethod: 'client_secret_post',
    },
    oauthEndpoints: {
      authorizationEndpoint: 'https://linear.app/oauth/authorize',
      tokenEndpoint: 'https://api.linear.app/oauth/token',
    },
    oauthScopeSeparator: ',',
  },
  {
    id: 'monday',
    name: 'monday.com',
    url: 'https://mcp.monday.com/mcp',
    description: `Inspect monday.com boards, items, updates, docs, and workspace context from ${PRODUCT_NAME} tasks`,
    icon: 'monday',
    oauthScopes: [...MONDAY_MCP_READ_ONLY_OAUTH_SCOPES],
    oauthScopeMode: 'read-only',
    serverMode: 'upstream_proxy',
    instructions:
      'Use monday.com to inspect boards, items, updates, docs, workspaces, forms, automations, meetings, and sprint context. This connection is read-only; do not assume mutation tools are available.',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    description: `Enable Sentry so this deployment can access alerts and performance indicators from ${PRODUCT_NAME} tasks.`,
    icon: 'sentry',
    connectionScope: 'deployment',
  },
  {
    id: 'pylon',
    name: 'Pylon',
    url: 'https://mcp.usepylon.com',
    description: `Enable Pylon so this deployment can access customer issues, message history, and account context from ${PRODUCT_NAME} tasks.`,
    icon: 'pylon',
    connectionScope: 'deployment',
  },
  {
    id: 'posthog',
    name: 'PostHog',
    url: 'https://mcp.posthog.com/mcp',
    description: `Access analytics, feature flags, experiments, and error tracking from ${PRODUCT_NAME} tasks`,
    icon: 'posthog',
    connectionScope: 'deployment',
    oauthScopeMode: 'read-only',
  },
  {
    id: 'neon',
    name: 'Neon',
    url: 'https://mcp.neon.tech/mcp',
    description: `Manage and query your DBs from ${PRODUCT_NAME} tasks`,
    icon: 'neon',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    url: 'https://mcp.supabase.com/mcp?read_only=true&features=database',
    description: 'Postgres platform with read-only database tools',
    icon: 'supabase',
  },
  {
    id: 'asana',
    name: 'Asana',
    description: `Connect Asana so your agents can inspect shared workspaces, projects, tasks, teams, and comments from ${PRODUCT_NAME} tasks`,
    icon: 'asana',
    connectionScope: 'deployment',
    connectionMode: 'admin_configured',
    serverMode: 'native',
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    description: `Connect Snowflake so your agents can query and explore your data warehouse from ${PRODUCT_NAME} tasks`,
    icon: 'snowflake',
    connectionScope: 'deployment',
    connectionMode: 'admin_configured',
    serverMode: 'native',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: `Connect Vercel so your agents can inspect shared teams, projects, deployments, domains, and logs from ${PRODUCT_NAME} tasks`,
    icon: 'vercel',
    connectionScope: 'deployment',
    connectionMode: 'admin_configured',
    serverMode: 'native',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    description: `Connect Grafana so your agents can inspect shared dashboards, alerting state, annotations, data sources, and monitoring context from ${PRODUCT_NAME} tasks`,
    icon: 'grafana',
    connectionScope: 'deployment',
    connectionMode: 'admin_configured',
    serverMode: 'native',
  },
  {
    id: 'betterstack',
    name: 'Better Stack',
    url: 'https://mcp.betterstack.com',
    description: `Enable Better Stack so this deployment can access read-only monitoring and incident context from ${PRODUCT_NAME} tasks.`,
    icon: 'betterstack',
    connectionScope: 'deployment',
    oauthScopes: ['read'],
    oauthScopeMode: 'read-only',
  },
  {
    id: 'railway',
    name: 'Railway',
    url: 'https://mcp.railway.com',
    description: `Access your Railway account, projects, and services from ${PRODUCT_NAME} tasks`,
    icon: 'railway',
    connectionScope: 'deployment',
    serverMode: 'upstream_proxy',
  },
  {
    id: 'resend',
    name: 'Resend',
    url: 'https://mcp.resend.com/mcp',
    description: `Inspect and manage shared email infrastructure through Resend from ${PRODUCT_NAME} tasks.`,
    icon: 'resend',
    connectionScope: 'deployment',
    connectionMode: 'oauth',
    serverMode: 'upstream_proxy',
    oauthEndpoints: {
      authorizationEndpoint: 'https://api.resend.com/oauth/authorize',
      tokenEndpoint: 'https://api.resend.com/oauth/token',
      registrationEndpoint: 'https://api.resend.com/oauth/register',
      tokenEndpointAuthMethod: 'none',
    },
    oauthScopes: ['full_access'],
    defaultDisabledTools: [...RESEND_DEFAULT_DISABLED_TOOL_NAMES],
    instructions:
      'Use Resend to inspect email delivery, received messages, domains, contacts, templates, broadcasts, and related infrastructure. Email sending, credential creation and removal, scheduled-send changes, domain and webhook mutations, automation mutations and triggers, and contact mutations are disabled until a deployment admin explicitly enables those tools.',
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    url: 'https://api.braintrust.dev/mcp',
    description: `Access prompts, runs and results from ${PRODUCT_NAME} tasks`,
    icon: 'braintrust',
  },
  {
    id: 'granola',
    name: 'Granola',
    description: `Connect Granola so your agents can browse meeting notes, transcripts, decisions, and action items from ${PRODUCT_NAME} tasks`,
    icon: 'granola',
    connectionScope: 'deployment',
    connectionMode: 'admin_configured',
    serverMode: 'native',
    instructions:
      'Use Granola to browse and read meeting notes, transcripts, folders, decisions, and action items through the deployment API key. The built-in tools are read-only.',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    description: `Connect ElevenLabs so ${PRODUCT_NAME} can narrate feature-demo videos with your voice. The API key stays on the control plane; agents get no ElevenLabs tools and the key never enters a task sandbox`,
    icon: 'elevenlabs',
    connectionScope: 'deployment',
    connectionMode: 'admin_configured',
    serverMode: 'credential_only',
  },
  {
    id: 'supermemory',
    name: 'Supermemory',
    url: 'https://mcp.supermemory.ai/mcp',
    description: `Enable Supermemory so this deployment can save and recall shared memories across ${PRODUCT_NAME} tasks.`,
    icon: 'supermemory',
    connectionScope: 'deployment',
    instructions: [
      'The Supermemory MCP tools share one persistent memory store across every task in this deployment.',
      '',
      'Recall early: when starting substantive work, use the Supermemory recall tool to check for relevant context such as team preferences, repository conventions, and decisions from earlier tasks before assuming that context does not exist. Recall is read-only and cheap; prefer one recall pass near the start of a task over skipping it.',
      '',
      'Save durable knowledge proactively: prefer writing useful shared memories when they appear. Do not wait for the user to ask you to save. Supermemory is designed to surface the relevant memories later, so missing durable context is worse than saving a few concise reusable facts.',
      '',
      'Save when you learn something future tasks should inherit, for example:',
      '- user or team preferences and durable corrections (for example "always open draft PRs")',
      '- deployment-wide conventions or workflow norms',
      '- lasting product or architecture decisions with rationale that future tasks must respect',
      '- recurring operational gotchas that cost real effort and will matter again',
      '- stable "how we do X here" guidance that is not already encoded in the repository',
      '',
      'When such knowledge appears mid-task, save it promptly as a short standalone fact. Near task closeout, do one final memory check and save any remaining durable findings from this task. Prefer concise reusable wording over conversation dumps.',
      '',
      'Never save task status or progress notes, code snippets or file contents, secrets or credentials, private one-task details, or anything easily rederivable from the repository. Do not dump transcripts or large blobs.',
    ].join('\n'),
  },
  {
    id: 'x',
    name: 'X',
    url: 'https://api.x.com/mcp',
    description: `Connect X so your agents can search posts, look up users, and pull trends and news into ${PRODUCT_NAME} tasks`,
    icon: 'x',
    connectionScope: 'deployment',
    connectionMode: 'admin_configured',
    serverMode: 'upstream_proxy',
    instructions:
      'Use X to search public posts, look up users and their posts, and pull trends, news, lists, Spaces, and community context. The connection uses an app-only bearer token, so it is read-only public data: posting, bookmarks, DMs, and other user-context tools are not available.',
  },
  {
    id: 'zero',
    name: 'Zero',
    url: 'https://mcp.zero.xyz',
    description: `Enable Zero so this deployment can discover and pay for external capabilities from ${PRODUCT_NAME} tasks`,
    icon: 'zero',
    connectionScope: 'deployment',
    serverMode: 'upstream_proxy',
    oauthScopes: [
      'tools:call',
      'capabilities:read',
      'sessions:create',
      'wallet:spend',
    ],
    instructions: [
      'Zero is available because a deployment operator connected it: the `zero` CLI and skill are installed for this task, and the Zero MCP connector handles authentication and funding.',
      '',
      'Prefer the `zero` CLI for the capability loop: `zero search` → `zero get` → `zero fetch` → `zero review`. Use the Zero MCP tools when the skill requires them for auth or funding.',
      '',
      'Capability spend comes from the deployment-connected Zero wallet. Search is free; paid fetches spend from that wallet. Set `--max-pay` on unfamiliar paid calls.',
      '',
      'Read the packaged `zero` skill before first use for auth, spend caps, and sandbox session exchange details.',
    ].join('\n'),
  },
];

export function getMcpIntegration(id: string): McpIntegration | undefined {
  return MCP_INTEGRATIONS.find((m) => m.id === id);
}

export function getMcpIntegrationConnectionScope(
  integrationOrId: McpIntegration | string | undefined,
  role: McpConnectionRole = 'default',
): 'user' | 'deployment' {
  if (!integrationOrId) {
    return 'user';
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  if (integration?.id === 'linear') {
    if (role === 'linear_user_link') {
      return 'user';
    }

    return 'deployment';
  }

  return integration?.connectionScope ?? 'user';
}

export function getDefaultMcpConnectionRole(
  integrationOrId: McpIntegration | string | undefined,
): McpConnectionRole {
  if (!integrationOrId) {
    return 'default';
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  if (integration?.id === 'linear') {
    return 'linear_org_install';
  }

  return 'default';
}

export function getMcpIntegrationConnectionMode(
  integrationOrId: McpIntegration | string | undefined,
): McpIntegrationConnectionMode {
  if (!integrationOrId) {
    return 'oauth';
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  return integration?.connectionMode ?? 'oauth';
}

export function isSelfServeMcpIntegration(
  integrationOrId: McpIntegration | string | undefined,
): boolean {
  return getMcpIntegrationConnectionMode(integrationOrId) === 'oauth';
}

export function isNativeMcpIntegration(
  integrationOrId: McpIntegration | string | undefined,
): boolean {
  if (!integrationOrId) {
    return false;
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  return integration?.serverMode === 'native';
}

/**
 * Credential-only integrations store admin-configured credentials for
 * control-plane features and expose no MCP tools to agents, so they get no
 * proxy route and are never delivered to task sandboxes.
 */
export function isCredentialOnlyMcpIntegration(
  integrationOrId: McpIntegration | string | undefined,
): boolean {
  if (!integrationOrId) {
    return false;
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  return integration?.serverMode === 'credential_only';
}

export function getMcpIntegrationUpstreamUrl(
  integrationOrId: McpIntegration | string | undefined,
): string | null {
  if (!integrationOrId) {
    return null;
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  return integration?.url ?? null;
}

export function isDeploymentScopedMcpIntegration(
  integrationOrId: McpIntegration | string | undefined,
  role: McpConnectionRole = 'default',
): boolean {
  return (
    getMcpIntegrationConnectionScope(integrationOrId, role) === 'deployment'
  );
}

export function getMcpIntegrationAuthorizationParameters(
  integrationOrId: McpIntegration | string | undefined,
  role: McpConnectionRole = 'default',
): McpIntegrationAuthorizationParameter[] {
  if (!integrationOrId) {
    return [];
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  if (!integration) {
    return [];
  }

  if (integration.id === 'linear') {
    return [
      {
        name: 'actor',
        value: role === 'linear_user_link' ? 'user' : 'app',
      },
    ];
  }

  return integration.authorizationParameters ?? [];
}

export function getMcpIntegrationOauthScopes(
  integrationOrId: McpIntegration | string | undefined,
  role: McpConnectionRole = 'default',
): string[] | undefined {
  if (!integrationOrId) {
    return undefined;
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  if (!integration) {
    return undefined;
  }

  if (integration.id === 'linear') {
    return role === 'linear_user_link'
      ? ['read']
      : [...LINEAR_APP_OAUTH_SCOPES];
  }

  return integration.oauthScopes;
}

export function getMcpIntegrationDefaultDisabledTools(
  integrationOrId: McpIntegration | string | undefined,
): readonly string[] {
  if (!integrationOrId) {
    return [];
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  return integration?.defaultDisabledTools ?? [];
}

export function getMcpIntegrationOauthEndpoints(
  integrationOrId: McpIntegration | string | undefined,
): McpIntegrationOAuthEndpoints | undefined {
  if (!integrationOrId) {
    return undefined;
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  return integration?.oauthEndpoints;
}

export function getMcpIntegrationOauthScopeSeparator(
  integrationOrId: McpIntegration | string | undefined,
): ' ' | ',' {
  if (!integrationOrId) {
    return ' ';
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  return integration?.oauthScopeSeparator ?? ' ';
}

export function getMcpIntegrationOauthScopeMode(
  integrationOrId: McpIntegration | string | undefined,
  _role: McpConnectionRole = 'default',
): McpIntegrationOauthScopeMode | undefined {
  if (!integrationOrId) {
    return undefined;
  }

  const integration =
    typeof integrationOrId === 'string'
      ? getMcpIntegration(integrationOrId)
      : integrationOrId;

  return integration?.oauthScopeMode;
}

export function isMcpConnectionOAuthConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionOAuthConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'oauth_client',
  );
}

export function isMcpConnectionSnowflakeConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionSnowflakeConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'snowflake',
  );
}

export function isMcpConnectionAsanaConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionAsanaConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'asana',
  );
}

export function isMcpConnectionGranolaConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionGranolaConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'granola' &&
    'encryptedApiKey' in authConfig &&
    typeof authConfig.encryptedApiKey === 'string',
  );
}

export function isMcpConnectionElevenLabsConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionElevenLabsConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'elevenlabs' &&
    'encryptedApiKey' in authConfig &&
    typeof authConfig.encryptedApiKey === 'string' &&
    'voiceId' in authConfig &&
    typeof authConfig.voiceId === 'string',
  );
}

export function isMcpConnectionVercelConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionVercelConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'vercel',
  );
}

export function isMcpConnectionXConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionXConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'x' &&
    'encryptedBearerToken' in authConfig &&
    typeof authConfig.encryptedBearerToken === 'string',
  );
}

export function isMcpConnectionGbrainConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionGbrainConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'gbrain' &&
    'url' in authConfig &&
    typeof authConfig.url === 'string' &&
    'agentClientId' in authConfig &&
    typeof authConfig.agentClientId === 'string' &&
    'encryptedAgentClientSecret' in authConfig &&
    typeof authConfig.encryptedAgentClientSecret === 'string' &&
    'ingestClientId' in authConfig &&
    typeof authConfig.ingestClientId === 'string' &&
    'encryptedIngestClientSecret' in authConfig &&
    typeof authConfig.encryptedIngestClientSecret === 'string' &&
    'maintenanceClientId' in authConfig &&
    typeof authConfig.maintenanceClientId === 'string' &&
    'encryptedMaintenanceClientSecret' in authConfig &&
    typeof authConfig.encryptedMaintenanceClientSecret === 'string',
  );
}

export function isMcpConnectionGrafanaConfig(
  authConfig: McpConnectionAuthConfig | null | undefined,
): authConfig is McpConnectionGrafanaConfig {
  return Boolean(
    authConfig &&
    typeof authConfig === 'object' &&
    'type' in authConfig &&
    authConfig.type === 'grafana',
  );
}

const GRAFANA_APP_ROUTE_SEGMENTS = new Set([
  'alerting',
  'connections',
  'dashboards',
  'datasources',
  'd',
  'd-solo',
  'explore',
]);

function findGrafanaPluginRouteIndex(pathnameSegments: string[]): number {
  if (
    pathnameSegments[0]?.toLowerCase() === 'a' &&
    pathnameSegments[2]?.toLowerCase() === 'a'
  ) {
    return 2;
  }

  if (
    pathnameSegments[0]?.toLowerCase() === 'a' &&
    pathnameSegments[1]?.toLowerCase() !== 'grafana'
  ) {
    return 0;
  }

  // Treat nested `/a/<plugin>` paths as plugin routes only when they appear
  // below a preserved instance root like `/grafana/a/<plugin>` or
  // `/a/<mount>/a/<plugin>`.
  for (let index = pathnameSegments.length - 2; index >= 1; index -= 1) {
    if (pathnameSegments[index]?.toLowerCase() === 'a') {
      return index;
    }
  }

  return -1;
}

export function normalizeGrafanaBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const pathnameSegments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const grafanaRouteIndex = pathnameSegments.findIndex((segment) =>
    GRAFANA_APP_ROUTE_SEGMENTS.has(segment.toLowerCase()),
  );
  const normalizedRouteIndex =
    grafanaRouteIndex === -1
      ? findGrafanaPluginRouteIndex(pathnameSegments)
      : grafanaRouteIndex;
  const normalizedSegments =
    normalizedRouteIndex === -1
      ? pathnameSegments
      : pathnameSegments.slice(0, normalizedRouteIndex);

  url.pathname =
    normalizedSegments.length > 0 ? `/${normalizedSegments.join('/')}` : '/';
  url.search = '';
  url.hash = '';

  return url.toString().replace(/\/$/u, '');
}
