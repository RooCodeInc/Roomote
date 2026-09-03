import YAML from 'yaml';
import { z } from 'zod';

import { PRODUCT_NAME } from './constants';
import { gitBranchNameSchema } from './git-ref';
import { collectReservedEnvReferences } from './reserved-mcp-env-vars';
import { SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME } from './sandbox-preview-inference';

const environmentEnvMapSchema = z.record(z.string()).superRefine((env, ctx) => {
  if (SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME in env) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME],
      message: `${SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME} is a deployment-level preview key and cannot be stored in an environment definition`,
    });
  }
});

/**
 * Command
 */

export const COMMAND_DEFAULT_TIMEOUT = 600;
export const COMMAND_RETRY_DELAY_MS = 1_000;

export const commandSchema = z.object({
  name: z.string().min(1, 'Command name is required'),
  run: z.string().min(1, 'Command run is required'),
  /**
   * Environment variables to set for this command.
   * These will be merged with process.env and any env vars passed to the executor.
   * Command-specific env vars take precedence over global ones.
   * @example { NODE_ENV: 'production', API_KEY: 'secret' }
   */
  env: environmentEnvMapSchema.optional(),
  working_dir: z.string().optional(),
  cwd: z.string().optional(),
  timeout: z.number().positive().default(COMMAND_DEFAULT_TIMEOUT),
  /**
   * Number of additional attempts for a failing command line.
   * Retries use a fixed 1-second delay and should only be used for
   * commands that are safe to run again.
   * @default 0
   * @example 4
   */
  retries: z.number().int().min(0).optional(),
  continue_on_error: z.boolean().default(false),
  /**
   * Run the command in the background.
   * Environment repository commands are supervised by PM2 so long-running
   * app processes restart after crashes; internal service setup may use a
   * lighter detached shell launcher.
   * Use with `logfile` to capture output.
   * @default false
   * @example true
   */
  detached: z.boolean().optional(),
  /**
   * Path to write stdout and stderr when running in detached mode.
   * Only used when `detached: true`.
   * @example '/tmp/server.log'
   */
  logfile: z.string().optional(),
});

export type Command = z.infer<typeof commandSchema>;

/**
 * Service - defines services that can be started in sandbox environments
 */

export const serviceNames = [
  'redis6',
  'redis7',
  'postgres15',
  'postgres16',
  'postgres17',
  'mysql8',
  'mariadb10',
  'clickhouse',
  'codeserver',
  'aws',
] as const;

export type ServiceName = (typeof serviceNames)[number];

export const serviceNameSchema = z.enum(serviceNames);

function filterLegacyServices(
  services: ServiceConfig[] | undefined,
): ServiceConfig[] | undefined {
  const supportedServices = services?.filter((service) => {
    const name = typeof service === 'string' ? service : service.name;
    return name !== 'codeserver';
  });

  return supportedServices && supportedServices.length > 0
    ? supportedServices
    : undefined;
}

/**
 * ServiceConfig - can be either a simple service name or an object with name and optional port
 * @example 'redis7' - use default port
 * @example { name: 'postgres16', port: 5433 } - use custom port
 */
export const serviceConfigSchema = z.union([
  serviceNameSchema,
  z.object({
    name: serviceNameSchema,
    port: z.number().int().positive().optional(),
  }),
]);

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

/**
 * Docker projects run customer-owned Docker Compose or Dockerfile services
 * inside the task sandbox after their repository has been prepared.
 */
const dockerProjectNameSchema = z
  .string()
  .min(1, 'Docker project name is required')
  .max(50)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    'Docker project name must start with a letter and contain only letters, numbers, underscores, and hyphens',
  );

const dockerProjectRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('~') &&
      !/^[a-zA-Z]:[\\/]/.test(value),
    { message: 'Path must be relative to the selected repository' },
  )
  .refine(
    (value) => !value.split(/[\\/]/).some((segment) => segment === '..'),
    { message: 'Path must stay within the selected repository' },
  );

export const dockerProjectPortSchema = z.object({
  /** Name of an entry in the environment's top-level `ports` list. */
  named_port: z.string().min(1),
  /** Compose service that owns the container port. Omitted for Dockerfiles. */
  service: z.string().min(1).optional(),
  container_port: z.number().int().min(1).max(65535),
});

const dockerProjectCommonShape = {
  name: dockerProjectNameSchema,
  repository: z
    .string()
    .regex(
      /^[^/]+(?:\/[^/]+)+$/,
      'Must reference a configured slash-separated repository name',
    ),
  working_dir: dockerProjectRelativePathSchema.optional(),
  env: environmentEnvMapSchema.optional(),
  ports: z.array(dockerProjectPortSchema).optional(),
  required: z.boolean().optional(),
  startup_timeout_seconds: z.number().int().positive().max(3600).optional(),
};

export const composeDockerProjectSchema = z.object({
  ...dockerProjectCommonShape,
  type: z.literal('compose'),
  files: z.array(dockerProjectRelativePathSchema).min(1),
  profiles: z.array(z.string().min(1)).optional(),
  services: z.array(z.string().min(1)).optional(),
});

export const dockerfileDockerProjectSchema = z.object({
  ...dockerProjectCommonShape,
  type: z.literal('dockerfile'),
  context: dockerProjectRelativePathSchema.optional(),
  dockerfile: dockerProjectRelativePathSchema.optional(),
  target: z.string().min(1).optional(),
  build_args: environmentEnvMapSchema.optional(),
  command: z.array(z.string()).min(1).optional(),
});

export const dockerProjectSchema = z.discriminatedUnion('type', [
  composeDockerProjectSchema,
  dockerfileDockerProjectSchema,
]);

export type DockerProjectPort = z.infer<typeof dockerProjectPortSchema>;
export type ComposeDockerProject = z.infer<typeof composeDockerProjectSchema>;
export type DockerfileDockerProject = z.infer<
  typeof dockerfileDockerProjectSchema
>;
export type DockerProject = z.infer<typeof dockerProjectSchema>;

/**
 * Normalize a configured Docker project name into the Compose project name
 * the worker uses (`--project-name`). Shared with the web app so both sides
 * derive identical log file paths.
 */
export function toComposeProjectName(name: string): string {
  return `roomote-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63);
}

export const DOCKER_PROJECT_LOGS_DIR = '/tmp/roomote-docker-projects';

/**
 * Well-known sandbox path of a Docker project's log file. The worker writes
 * Compose startup output, failure diagnostics, and a live `docker compose
 * logs --follow` stream here; the web Logs panel tails it by this path.
 */
export function getDockerProjectLogFilePath(name: string): string {
  return `${DOCKER_PROJECT_LOGS_DIR}/${toComposeProjectName(name)}.log`;
}

/**
 * Default ports for each service.
 */
export const serviceDefaultPorts: Record<ServiceName, number> = {
  redis6: 6379,
  redis7: 6379,
  postgres15: 5432,
  postgres16: 5432,
  postgres17: 5432,
  mysql8: 3306,
  mariadb10: 3306,
  clickhouse: 9000,
  codeserver: 0, // Legacy compatibility only. Removed at runtime.
  aws: 0, // CLI tool, no port needed.
};

/**
 * ServiceInfo - runtime information about a started service.
 */
export interface ServiceInfo {
  name: ServiceName;
  port: number;
  host: string;
  connectionString: string;
  envVars: Record<string, string>;
}

/**
 * EnvironmentRepositoryConfig
 */

const toolVersionsSchema = z.record(z.string().min(1), z.string().min(1));

export const environmentRepositoryConfigSchema = z.object({
  /**
   * Repository full name as stored in the repositories table. GitHub and
   * Gitea use owner/repo; GitLab subgroups and Azure DevOps
   * (organization/project/repo) produce three or more segments.
   */
  repository: z
    .string()
    .regex(
      /^[^/]+(?:\/[^/]+)+$/,
      'Must be a slash-separated repository full name such as owner/repo',
    ),
  /**
   * Branch to checkout for this repository.
   * If not specified, uses the repository's default branch.
   * @example 'main'
   * @example 'feature/my-feature'
   */
  branch: gitBranchNameSchema.optional(),
  /**
   * Repo-local tool-version fallbacks to install via mise for this repository.
   * Checked-in repo tool config stays authoritative; these entries only fill
   * missing tools for this repo without replacing repo-owned pins.
   * @example { node: "20.11.0", python: "3.12.1" }
   */
  tool_versions: toolVersionsSchema.optional(),
  commands: z.array(commandSchema).optional(),
});

export type EnvironmentRepositoryConfig = z.infer<
  typeof environmentRepositoryConfigSchema
>;

const RESERVED_NAMED_PORT_NAMES = new Set(['SANDBOX_SERVER', 'EDITOR']);
const RESERVED_ENVIRONMENT_PORT_NUMBERS = new Set<number>();

export const namedPortSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      'Name must start with a letter and contain only letters, numbers, and underscores',
    )
    .superRefine((value, ctx) => {
      if (RESERVED_NAMED_PORT_NAMES.has(value.toUpperCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Port name '${value}' is reserved for Roomote system use`,
        });
      }
    }),
  port: z.number().min(1024).max(65535),
  unauthenticated: z.boolean().optional(),
  proxied: z.boolean().optional(),
  initial_path: z
    .string()
    .regex(/^\//, 'Initial path must start with /')
    .regex(
      /^\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/,
      'Initial path must be a valid URI path',
    )
    .optional(),
  wildcard_prefix: z.boolean().optional(),
  subdomain: z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
      'Must be a valid DNS hostname prefix (lowercase alphanumeric, hyphens, dots)',
    )
    .optional(),
  auth_bypass_paths: z
    .array(z.string().min(1).regex(/^\//, 'Path must start with /'))
    .max(20)
    .optional(),
  primary: z.boolean().optional(),
});

export type NamedPort = z.infer<typeof namedPortSchema>;

type ReservedEnvironmentPortConflict = {
  path: (string | number)[];
  port: number;
};

export function getReservedEnvironmentPortMessage(port: number): string {
  return `Port number '${port}' is reserved for ${PRODUCT_NAME} system use`;
}

function getReservedEnvironmentPortConflicts(
  config: Partial<Pick<EnvironmentConfig, 'ports' | 'services'>>,
): ReservedEnvironmentPortConflict[] {
  const conflicts: ReservedEnvironmentPortConflict[] = [];

  config.ports?.forEach((namedPort, index) => {
    if (RESERVED_ENVIRONMENT_PORT_NUMBERS.has(namedPort.port)) {
      conflicts.push({ path: ['ports', index, 'port'], port: namedPort.port });
    }
  });

  config.services?.forEach((service, index) => {
    if (
      typeof service !== 'string' &&
      service.port &&
      RESERVED_ENVIRONMENT_PORT_NUMBERS.has(service.port)
    ) {
      conflicts.push({ path: ['services', index, 'port'], port: service.port });
    }
  });

  return conflicts;
}

export function assertNoReservedEnvironmentPorts(
  config: Partial<Pick<EnvironmentConfig, 'ports' | 'services'>>,
): void {
  const conflict = getReservedEnvironmentPortConflicts(config)[0];

  if (conflict) {
    throw new Error(getReservedEnvironmentPortMessage(conflict.port));
  }
}

/**
 * Converts a port name to a URL-safe slug for use in preview-proxy subdomain.
 * Port names use uppercase with underscores (e.g., MY_APP), but URLs must be
 * DNS-safe and only accept lowercase with hyphens (e.g., my-app).
 *
 * @example portNameToSlug('MY_APP') => 'my-app'
 * @example portNameToSlug('WEB') => 'web'
 */
export function portNameToSlug(name: string): string {
  return name.toLowerCase().replaceAll('_', '-');
}

/**
 * Converts a URL port slug back to a storage key.
 * URL slugs are lowercase with hyphens; storage keys are uppercase with underscores.
 * This is the inverse of portNameToSlug().
 *
 * @example slugToPortKey('my-app') => 'MY_APP'
 * @example slugToPortKey('web') => 'WEB'
 */
export function slugToPortKey(slug: string): string {
  return slug.replaceAll('-', '_').toUpperCase();
}

/**
 * MCP server config sections that can be declared in environment config.
 * This mirrors the JSON shape used by MCP configs and is intentionally
 * constrained to transports supported by the worker runtime.
 */
const environmentMcpServerStreamableHttpInputSchema = z.object({
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  command: z.undefined().optional(),
  args: z.undefined().optional(),
  env: z.undefined().optional(),
});

export const environmentMcpServerStreamableHttpSchema =
  environmentMcpServerStreamableHttpInputSchema
    .passthrough()
    .transform((config) => ({
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
    }));

const environmentMcpServerStdioInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: environmentEnvMapSchema.optional(),
  url: z.undefined().optional(),
  headers: z.undefined().optional(),
});

export const environmentMcpServerStdioSchema =
  environmentMcpServerStdioInputSchema.passthrough().transform((config) => ({
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
  }));

export const environmentMcpServerConfigSchema = z.union([
  environmentMcpServerStreamableHttpSchema,
  environmentMcpServerStdioSchema,
]);

/**
 * Every operator-supplied string in an MCP entry is serialized verbatim into
 * the harness config, where both substitution engines resolve references
 * against the sandbox environment.
 *
 * Map *keys* are serialized just as literally as their values, and OpenCode
 * substitutes over the whole config text, so a reference in a header name or
 * an environment variable name leaks exactly as readily as one in a value.
 * Collect keys and values alike.
 */
function collectMcpConfigStrings(config: EnvironmentMcpServerConfig): string[] {
  if ('command' in config) {
    return [
      config.command,
      ...(config.args ?? []),
      ...Object.entries(config.env ?? {}).flat(),
    ];
  }

  return [config.url, ...Object.entries(config.headers ?? {}).flat()];
}

export const environmentMcpServersSchema = z
  .record(z.string().min(1), environmentMcpServerConfigSchema)
  .superRefine((servers, ctx) => {
    for (const [serverName, config] of Object.entries(servers)) {
      const reserved = Array.from(
        new Set(
          [serverName, ...collectMcpConfigStrings(config)].flatMap(
            collectReservedEnvReferences,
          ),
        ),
      );

      if (reserved.length === 0) {
        continue;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [serverName],
        message:
          `MCP server '${serverName}' references reserved ${PRODUCT_NAME} ` +
          `runtime environment variables (${reserved.join(', ')}). These name ` +
          `runtime credentials and cannot be interpolated into MCP server ` +
          `config. Define your own deployment environment variable under a ` +
          `different name and reference that instead.`,
      });
    }
  });

export type EnvironmentMcpServerConfig = z.infer<
  typeof environmentMcpServerConfigSchema
>;
export type EnvironmentMcpServers = z.infer<typeof environmentMcpServersSchema>;

/**
 * EnvironmentConfig
 */

const environmentSkillSourceSchema = z
  .string()
  .regex(/^[^/]+\/[^/]+$/, 'Skill source key must be in owner/repo format');

const environmentSkillNameSchema = z
  .string()
  .min(1)
  .regex(/^[^/\s]+$/, 'Skill name must not contain "/" or whitespace')
  .refine(
    (skillName) => skillName.trim().length > 0,
    'Skill name cannot be empty or whitespace-only',
  );

const environmentSkillSelectionSchema = z.union([
  z.literal('all'),
  z.array(environmentSkillNameSchema).min(1),
]);

export type EnvironmentManualSkill = {
  name: string;
  description: string;
  content: string;
};

export function normalizeManualSkillContent(skillContent: string): string {
  const normalized = skillContent.replace(/\r\n/g, '\n').trim();

  return normalized.length > 0 ? `${normalized}\n` : '';
}

export function renderManualSkillMarkdown(skill: {
  name: string;
  description: string;
  content: string;
}): string {
  const frontmatter = YAML.stringify({
    name: skill.name,
    description: skill.description.trim(),
  }).trimEnd();
  const normalizedContent = normalizeManualSkillContent(skill.content);

  return `---\n${frontmatter}\n---\n\n${normalizedContent}`;
}

export const environmentManualSkillSchema = z.object({
  name: environmentSkillNameSchema,
  description: z
    .string()
    .trim()
    .min(1, 'Manual skill description cannot be empty.'),
  content: z
    .string()
    .transform(normalizeManualSkillContent)
    .refine(
      (content) => content.length > 0,
      'Manual skill content must include non-empty instructions.',
    ),
});

function addManualSkillDuplicateNameIssues(
  manualSkills: Array<{ name: string }>,
  ctx: z.RefinementCtx,
) {
  const seenNames = new Set<string>();

  manualSkills.forEach((manualSkill, index) => {
    if (!seenNames.has(manualSkill.name)) {
      seenNames.add(manualSkill.name);
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [index, 'name'],
      message: `Manual skill name "${manualSkill.name}" must be unique within an environment.`,
    });
  });
}

function sortEnvironmentManualSkills(
  manualSkills: EnvironmentManualSkill[],
): EnvironmentManualSkill[] {
  return [...manualSkills].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

const environmentManualSkillListSchema = z
  .array(environmentManualSkillSchema)
  .superRefine(addManualSkillDuplicateNameIssues)
  .transform(sortEnvironmentManualSkills);

const environmentManualSkillsSchema = environmentManualSkillListSchema;

const MAX_SANDBOX_PORTS = 4;
const MAX_NON_PROXIED_PORTS = 2;
const MAX_PROXIED_PORTS = 10;
export const DEFAULT_ENVIRONMENT_AWS_OIDC_AUDIENCE = 'sts.amazonaws.com';
export const DEFAULT_ENVIRONMENT_AWS_OIDC_TOKEN_FILE =
  '/home/roomote/.roomote/oidc/aws/token';
const environmentInitialUrlSchema = z.union([
  z.literal('about:blank'),
  z.string().url(),
]);

function validatePortLimits(ports: NamedPort[]): boolean {
  const proxiedPorts = ports.filter((port) => port.proxied !== false);
  const nonProxiedPorts = ports.filter((port) => port.proxied === false);

  if (proxiedPorts.length > MAX_PROXIED_PORTS) {
    return false;
  }

  if (nonProxiedPorts.length > MAX_NON_PROXIED_PORTS) {
    return false;
  }

  return true;
}

const oidcTokenFileSchema = z
  .string()
  .min(1)
  .regex(/^\//, 'OIDC token files must use absolute paths');

export const environmentOidcTargetKinds = ['aws', 'custom'] as const;

export type EnvironmentOidcTargetKind =
  (typeof environmentOidcTargetKinds)[number];

export const environmentAwsOidcSchema = z.object({
  audience: z.string().min(1).default(DEFAULT_ENVIRONMENT_AWS_OIDC_AUDIENCE),
  token_file: oidcTokenFileSchema.default(
    DEFAULT_ENVIRONMENT_AWS_OIDC_TOKEN_FILE,
  ),
  region: z.string().min(1).optional(),
  role_arn: z.string().min(1),
});

export type EnvironmentAwsOidcConfig = z.infer<typeof environmentAwsOidcSchema>;

export const environmentCustomOidcTargetSchema = z.object({
  audience: z.string().min(1),
  token_file: oidcTokenFileSchema,
});

export type EnvironmentCustomOidcTarget = z.infer<
  typeof environmentCustomOidcTargetSchema
>;

export const environmentOidcSchema = z
  .object({
    aws: environmentAwsOidcSchema.optional(),
    custom: z.array(environmentCustomOidcTargetSchema).optional(),
  })
  .superRefine((value, ctx) => {
    const tokenFiles = new Map<string, string>();

    if (value.aws) {
      tokenFiles.set(value.aws.token_file, 'aws');
    }

    value.custom?.forEach((target, index) => {
      const duplicateSource = tokenFiles.get(target.token_file);

      if (duplicateSource) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['custom', index, 'token_file'],
          message: `OIDC token file "${target.token_file}" is already used by ${duplicateSource}`,
        });
        return;
      }

      tokenFiles.set(target.token_file, `custom[${index}]`);
    });
  });

export type EnvironmentOidcConfig = z.infer<typeof environmentOidcSchema>;

export const environmentConfigSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    /**
     * Initial URL for the shared preview/browser surface.
     * When omitted, the preview path opens `about:blank`.
     * Supports absolute URLs and `about:blank`.
     * @example 'http://127.0.0.1:3000'
     * @example 'https://example.com/dashboard'
     * @example 'about:blank'
     */
    initialUrl: environmentInitialUrlSchema.optional(),
    /**
     * Instructions for LLM agents working in this environment.
     * These are included in the startup environment-instructions block delivered
     * through the harness system prompt to provide environment-specific context,
     * guidelines, or constraints.
     * @example "This is a monorepo. The frontend is in packages/web and the API is in packages/api."
     */
    agentInstructions: z.string().max(10000).optional(),
    repositories: z.array(environmentRepositoryConfigSchema).min(1),
    /**
     * Tool versions to install via mise at the shared workspace root.
     * Useful for workspace-root commands and as a broad fallback for repos
     * that do not already pin a given tool locally.
     * @example { node: "22.14.0", python: "3.12.1" }
     */
    tool_versions: toolVersionsSchema.optional(),
    env: environmentEnvMapSchema.optional(),
    services: z
      .array(serviceConfigSchema)
      .optional()
      .transform(filterLegacyServices),
    /**
     * Customer-owned Docker Compose projects or Dockerfiles to start after
     * their repositories have been prepared.
     */
    docker_projects: z.array(dockerProjectSchema).optional(),
    /**
     * Optional sandbox OIDC targets for this environment.
     * Tokens are minted by Roomote, written into the sandbox filesystem, and
     * refreshed externally while the sandbox stays active.
     *
     * @example
     * oidc:
     *   aws:
     *     role_arn: arn:aws:iam::123456789012:role/example
     *   custom:
     *     - audience: my-audience
     *       token_file: /home/roomote/.roomote/oidc/custom/token
     */
    oidc: environmentOidcSchema.optional(),
    /**
     * Named preview ports for human-facing application URLs.
     * Each port gets an authenticated shareable URL in
     * `ROOMOTE_<NAME>_PREVIEW_URL`. `ROOMOTE_<NAME>_HOST` points to that same
     * URL for proxied ports and to the direct machine URL for unproxied ports.
     */
    ports: z
      .array(namedPortSchema)
      .refine(
        (ports) => validatePortLimits(ports),
        `Exceeds port limits: max ${MAX_PROXIED_PORTS} proxied ports, max ${MAX_NON_PROXIED_PORTS} non-proxied ports`,
      )
      .optional(),
    /**
     * @deprecated Ignored. Live previews are always enabled; availability is
     * determined by the preview runtime configuration and `ports`. Kept
     * parseable so stored configs that still contain it remain valid.
     */
    previews_enabled: z.boolean().optional(),
    /**
     * Optional custom MCP servers for this environment.
     * These are merged into built-in MCPs when the worker starts a task,
     * enabling environment-specific integrations and tools.
     *
     * @example
     * mcpServers:
     *   linear:
     *     url: https://mcp.linear.app/mcp
     */
    mcpServers: environmentMcpServersSchema.optional(),
    /**
     * Optional installable skills for this environment.
     * Each source is installed during worker setup with:
     * `npx skills add <owner/repo> -g -y` (all skills), or:
     * `npx skills add <owner/repo> --skill <name> --skill <name> -g -y`.
     *
     * Keys must be in owner/repo format.
     *
     * @example
     * skills:
     *   dbt-labs/dbt-agent-skills: all
     *   anthropics/skills:
     *     - frontend-design
     *   vercel-labs/agent-skills:
     *     - web-design-guidelines
     */
    skills: z
      .record(environmentSkillSourceSchema, environmentSkillSelectionSchema)
      .optional(),
    /**
     * Optional inline manual skills for this environment.
     * Each entry is rendered into `<skill-name>/SKILL.md` and installed during
     * worker setup with `npx skills add <local-path> -g --all --copy`.
     *
     * @example
     * manualSkills:
     *   - name: my-manual-skill
     *     description: Adds custom Roomote behavior.
     *     content: |
     *       # My Manual Skill
     *
     *       Custom instructions.
     */
    manualSkills: environmentManualSkillsSchema.optional(),
    /**
     * Enable header-based auth bypass for this environment.
     * When set to `true`, Roomote may generate a random bypass value when an
     * exposed authenticated preview port needs one.
     * When set to a string (min 8 chars), that literal value is used as the
     * bypass secret when a bypass is needed.
     * When omitted, defaults to auto generation when an eligible surface exists.
     * When set to `false`, auth bypass is explicitly disabled.
     *
     * The bypass header name defaults to `x-bypass-roomote-auth` but can be
     * overridden via `auth_bypass_header_name` for nested Roomote stacks.
     *
     * @default auto when needed
     * @example true - auto-generate a random bypass value when needed
     * @example false - explicitly disable auth bypass
     * @example "my-webhook-secret-123" - use a fixed bypass secret
     */
    auth_bypass_header: z
      .union([z.literal(true), z.literal(false), z.string().min(8).max(256)])
      .optional(),
    /**
     * Custom header name for the auth bypass mechanism.
     * Defaults to `x-bypass-roomote-auth` when not specified.
     * Override this for nested Roomote stacks where each layer needs
     * a distinct header name to avoid stripping each other's bypass header.
     *
     * Must be a valid HTTP header name (RFC 7230): one or more token characters
     * (alphanumeric plus `!#$%&'*+-.^_``|~`).
     *
     * @example 'x-bypass-inner-auth'
     */
    auth_bypass_header_name: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/,
        'Must be a valid HTTP header name (RFC 7230 token characters)',
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    for (const conflict of getReservedEnvironmentPortConflicts(data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: getReservedEnvironmentPortMessage(conflict.port),
        path: conflict.path,
      });
    }

    if (data.ports && data.ports.length > 0) {
      const seenPortSubdomains = new Set<string>();

      for (const port of data.ports) {
        const key = `${port.port}::${port.subdomain ?? ''}`;

        if (seenPortSubdomains.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate port number: ${port.port}`,
            path: ['ports'],
          });
        }

        seenPortSubdomains.add(key);
      }

      const seenNames = new Set<string>();

      for (const port of data.ports) {
        const name = port.name.toUpperCase();

        if (seenNames.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate port name: ${port.name}`,
            path: ['ports'],
          });
        }

        seenNames.add(name);
      }

      const primaryPorts = data.ports.filter((port) => port.primary === true);

      if (primaryPorts.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Only one port can be marked as primary, found ${primaryPorts.length}`,
          path: ['ports'],
        });
      }
    }

    if (data.services && data.services.length > 0 && data.ports) {
      const portNameSet = new Set(
        data.ports.map((port) => port.name.toLowerCase()),
      );

      for (const service of data.services) {
        const serviceName =
          typeof service === 'string' ? service : service.name;

        if (portNameSet.has(serviceName.toLowerCase())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Service name '${serviceName}' conflicts with a port name`,
            path: ['services'],
          });
        }
      }
    }

    if (data.docker_projects && data.docker_projects.length > 0) {
      const configuredRepositories = new Set(
        data.repositories.map((repository) => repository.repository),
      );
      const configuredPortNames = new Set(
        (data.ports ?? []).map((port) => port.name.toUpperCase()),
      );
      const seenProjectNames = new Set<string>();
      const seenNamedPorts = new Set<string>();

      data.docker_projects.forEach((project, projectIndex) => {
        const normalizedProjectName = project.name.toLowerCase();
        if (seenProjectNames.has(normalizedProjectName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate Docker project name: ${project.name}`,
            path: ['docker_projects', projectIndex, 'name'],
          });
        }
        seenProjectNames.add(normalizedProjectName);

        if (!configuredRepositories.has(project.repository)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Docker project repository '${project.repository}' is not configured in this environment`,
            path: ['docker_projects', projectIndex, 'repository'],
          });
        }

        project.ports?.forEach((port, portIndex) => {
          const normalizedPortName = port.named_port.toUpperCase();
          if (!configuredPortNames.has(normalizedPortName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Docker project port '${port.named_port}' is not configured in the environment ports list`,
              path: [
                'docker_projects',
                projectIndex,
                'ports',
                portIndex,
                'named_port',
              ],
            });
          }

          if (seenNamedPorts.has(normalizedPortName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Environment port '${port.named_port}' can only be mapped by one Docker project`,
              path: [
                'docker_projects',
                projectIndex,
                'ports',
                portIndex,
                'named_port',
              ],
            });
          }
          seenNamedPorts.add(normalizedPortName);

          if (project.type === 'compose' && !port.service) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Compose port mappings require a service name',
              path: [
                'docker_projects',
                projectIndex,
                'ports',
                portIndex,
                'service',
              ],
            });
          }
        });
      });
    }
  });

export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;

export interface ResolvedEnvironmentOidcTarget {
  kind: EnvironmentOidcTargetKind;
  audience: string;
  tokenFile: string;
  roleArn?: string;
  region?: string;
}

export function getEnvironmentOidcTargets(
  config: Pick<EnvironmentConfig, 'oidc'> | undefined,
): ResolvedEnvironmentOidcTarget[] {
  if (!config?.oidc) {
    return [];
  }

  const targets: ResolvedEnvironmentOidcTarget[] = [];

  if (config.oidc.aws) {
    targets.push({
      kind: 'aws',
      audience: config.oidc.aws.audience,
      tokenFile: config.oidc.aws.token_file,
      roleArn: config.oidc.aws.role_arn,
      region: config.oidc.aws.region,
    });
  }

  for (const target of config.oidc.custom ?? []) {
    targets.push({
      kind: 'custom',
      audience: target.audience,
      tokenFile: target.token_file,
    });
  }

  return targets;
}

export function hasEnvironmentOidcTargets(
  config: Pick<EnvironmentConfig, 'oidc'> | undefined,
): boolean {
  return getEnvironmentOidcTargets(config).length > 0;
}

export const MULTI_INSTALLATION_ENVIRONMENT_REPOSITORIES_ERROR =
  'Environment repositories must all belong to the same GitHub App installation.';

export function getDuplicateEnvironmentRepositoryConfigError(
  repositories: Array<{ repository: string }>,
): string | null {
  const seen = new Set<string>();
  const duplicate = repositories.find((repository) => {
    if (seen.has(repository.repository)) {
      return true;
    }

    seen.add(repository.repository);
    return false;
  });

  return duplicate ? `Duplicate repository: ${duplicate.repository}` : null;
}

export function getAmbiguousEnvironmentRepositoryError(
  repositories: Array<{ fullName: string }>,
): string | null {
  const seen = new Set<string>();
  const duplicate = repositories.find((repository) => {
    if (seen.has(repository.fullName)) {
      return true;
    }

    seen.add(repository.fullName);
    return false;
  });

  return duplicate
    ? `Multiple repositories are named "${duplicate.fullName}". Environment repository names must be unique across source-control connections.`
    : null;
}

type EnvironmentRepositoryInstallationReference = {
  fullName: string;
  installationId: string | number | null | undefined;
};

export function getEnvironmentRepositoryInstallationError(
  repositories: EnvironmentRepositoryInstallationReference[],
): string | null {
  const installationIds = new Set(
    repositories
      .map((repository) => repository.installationId)
      .filter(
        (installationId): installationId is string | number =>
          installationId !== null && installationId !== undefined,
      ),
  );

  if (installationIds.size <= 1) {
    return null;
  }

  return MULTI_INSTALLATION_ENVIRONMENT_REPOSITORIES_ERROR;
}

export function getMissingEnvironmentRepositoryError(
  repositoryNames: string[],
  repositoryRows: Array<{ fullName: string }>,
): string | null {
  const linkedRepositoryNames = new Set(
    repositoryRows.map((repository) => repository.fullName),
  );
  const missingRepositories = repositoryNames.filter(
    (name) => !linkedRepositoryNames.has(name),
  );

  if (missingRepositories.length === 0) {
    return null;
  }

  return `Repositories are not linked to this deployment: ${missingRepositories.join(', ')}`;
}

export function getPrimaryPortFromConfig(
  ports: NamedPort[] | undefined,
): NamedPort | undefined {
  if (!ports || ports.length === 0) {
    return undefined;
  }

  return ports.find((port) => port.primary === true) ?? ports[0];
}

// Export constants for use in other modules
export { MAX_SANDBOX_PORTS, MAX_NON_PROXIED_PORTS, MAX_PROXIED_PORTS };
