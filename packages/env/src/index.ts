import { createEnv } from '@t3-oss/env-nextjs';
import {
  DEFAULT_LOCAL_DOCKER_WORKER_IMAGE,
  resolveEffectiveDockerWorkerImage,
} from '@roomote/types';
import { z } from 'zod';

import {
  getDefaultPreviewProxyBaseUrl,
  getDefaultRoomoteAppUrl,
  getDefaultTrpcUrl,
  resolveAppEnv,
} from './app-env';

const sharedSchema = {
  NODE_ENV: z.enum(['test', 'development', 'production']),
};

type NodeEnv = 'test' | 'development' | 'production';

// No committed JOB_AUTH / PREVIEW_AUTH keypair defaults: development
// auto-generates them via shouldAutoGenerateAuthKeypairs (see below).

const LOCAL_ENCRYPTION_KEY = 'local-roomote-encryption-key-0001';
const LOCAL_ARTIFACT_SIGNING_KEY = 'local-roomote-artifact-signing-key-1';
const LOCAL_DASHBOARD_PASSWORD = 'roomote-local-admin';
const LOCAL_PREVIEW_DOMAINS = 'localhost,127.0.0.1,roomotepreview.localhost';
const LOCAL_S3_ENDPOINT = 'http://localhost:19000';
const LOCAL_S3_PRESIGN_ENDPOINT = LOCAL_S3_ENDPOINT;
const LOCAL_S3_REGION = 'us-east-1';
const LOCAL_S3_ACCESS_KEY_ID = 'roomote';
const LOCAL_S3_SECRET_ACCESS_KEY = 'roomote-local-artifacts-password';
const LOCAL_S3_BUCKET_ARTIFACTS = 'roomote-artifacts';

function parseNodeEnv(value: string | undefined): NodeEnv | null {
  switch (value) {
    case 'test':
    case 'development':
    case 'production':
      return value;
    default:
      return null;
  }
}

function emptyStringDefault() {
  return z.string().default('');
}

function dockerSize() {
  return z.string().regex(/^\d+(?:\.\d+)?[kmgt]?b?$/i, 'Invalid Docker size');
}

function optInBoolean() {
  return z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1');
}

const serverSchema = {
  R_APP_ENV: z.enum(['development', 'preview', 'production']).optional(),
  APP_ENV: z.enum(['development', 'preview', 'production']).optional(),
  DEFAULT_COMPUTE_PROVIDER: z
    .enum(['roomote-cloud', 'modal', 'docker', 'daytona', 'e2b', 'blaxel'])
    .default('docker'),
  EXCLUDED_COMPUTE_PROVIDERS: z.string().optional(),
  ROOMOTE_CLOUD_URL: z.string().url().optional(),
  ROOMOTE_CLOUD_DEPLOYMENT_TOKEN: z.string().min(1).optional(),
  DOCKER_WORKER_IMAGE: z
    .string()
    .min(1)
    .default(DEFAULT_LOCAL_DOCKER_WORKER_IMAGE),
  // Default to the host's architecture so arm64 hosts (Apple Silicon dev,
  // arm servers) run the native worker-image variant instead of emulating
  // amd64. Only the Docker compute provider consumes this; hosted providers
  // (Modal/E2B/Daytona) run amd64 and resolve it from the image manifest.
  DOCKER_WORKER_PLATFORM: z
    .string()
    .min(1)
    .default(process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'),
  DOCKER_WORKER_NETWORK: z.string().min(1).optional(),
  DOCKER_WORKER_RELEASE_PATH: z.string().min(1).optional(),
  DOCKER_WORKER_CPU_LIMIT: z.coerce.number().positive().default(2),
  DOCKER_WORKER_MEMORY_LIMIT: dockerSize().default('4g'),
  DOCKER_WORKER_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
  DOCKER_WORKER_DISK_LIMIT: dockerSize().default('20g'),
  DOCKER_WORKER_ALLOW_UNBOUNDED_DISK: optInBoolean(),
  DOCKER_WORKER_LOG_MAX_SIZE: dockerSize().default('10m'),
  DOCKER_WORKER_LOG_MAX_FILES: z.coerce.number().int().positive().default(3),
  DOCKER_WORKER_EGRESS_POLICY: z.enum(['internet', 'none']).default('internet'),
  DOCKER_STANDBY_MAX_COUNT: z.coerce.number().int().nonnegative().default(10),
  DOCKER_STANDBY_MAX_AGE_HOURS: z.coerce
    .number()
    .positive()
    .max(168)
    .default(24),
  BLAXEL_STANDBY_MAX_COUNT: z.coerce.number().int().nonnegative().default(25),
  BLAXEL_STANDBY_MAX_AGE_HOURS: z.coerce
    .number()
    .positive()
    .max(168)
    .default(168),
  R_PUBLIC_URL: z.string().url().optional(),
  R_APP_URL: z.string().min(1),
  // Anonymous telemetry + version checks (Ping service).
  R_PING_BASE_URL: z.string().url().default('https://ping.roomote.dev'),
  // Force-enable telemetry in environments that would otherwise stay silent
  // (development / builds without RELEASE_VERSION). Testing escape hatch.
  ROOMOTE_FORCE_TELEMETRY: z.string().optional(),
  // Release tag baked into published app images by the publish workflow.
  RELEASE_VERSION: z.string().min(1).optional(),
  TRPC_URL: z.string().min(1),
  R_MODEL: z.string().min(1).optional(),
  R_SMALL_MODEL: z.string().min(1).optional(),
  R_VISION_MODEL: z.string().min(1).optional(),
  R_CODE_REVIEW_MODEL: z.string().min(1).optional(),
  R_EXPLORE_MODEL: z.string().min(1).optional(),
  R_PLANNING_MODEL: z.string().min(1).optional(),
  R_MODEL_REASONING_EFFORT: z.string().min(1).optional(),
  R_SMALL_MODEL_REASONING_EFFORT: z.string().min(1).optional(),
  R_VISION_MODEL_REASONING_EFFORT: z.string().min(1).optional(),
  R_CODE_REVIEW_MODEL_REASONING_EFFORT: z.string().min(1).optional(),
  R_EXPLORE_MODEL_REASONING_EFFORT: z.string().min(1).optional(),
  R_PLANNING_MODEL_REASONING_EFFORT: z.string().min(1).optional(),
  R_MODEL_ENV_KEYS: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  R_AUTO_GENERATE_KEYS: z.string().optional(),
  JOB_AUTH_PRIVATE_KEY: emptyStringDefault(),
  JOB_AUTH_PUBLIC_KEY: emptyStringDefault(),
  PREVIEW_AUTH_PRIVATE_KEY: emptyStringDefault(),
  PREVIEW_AUTH_PUBLIC_KEY: emptyStringDefault(),
  SANDBOX_OIDC_PRIVATE_KEY: z.string().min(1).optional(),
  SANDBOX_OIDC_PUBLIC_KEY: z.string().min(1).optional(),
  SANDBOX_OIDC_PUBLIC_KEY_SECONDARY: z.string().min(1).optional(),
  R_GITHUB_APP_ID: emptyStringDefault(),
  R_GITHUB_APP_SLUG: z.string().min(1).default('roomote'),
  R_GITHUB_APP_PRIVATE_KEY: emptyStringDefault(),
  R_GITHUB_CLIENT_ID: emptyStringDefault(),
  R_GITHUB_CLIENT_SECRET: emptyStringDefault(),
  GITHUB_MCP_SERVER_URL: z.string().min(1).optional(),
  R_GITHUB_WEBHOOK_SECRET: emptyStringDefault(),
  GITLAB_WEBHOOK_SECRET: emptyStringDefault(),
  GITLAB_WEBHOOK_SIGNING_TOKEN: emptyStringDefault(),
  WORKER_RELEASE_CHANNEL: z.enum(['stable', 'preview']).optional(),
  WORKER_RELEASE_VERSION: z.string().min(1).optional(),
  SLACK_APP_ID: emptyStringDefault(),
  R_SLACK_CLIENT_ID: z.string().min(1).optional(),
  R_SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  SLACK_REDIRECT_URI: emptyStringDefault(),
  SLACK_AUTH_URI: emptyStringDefault(),
  R_SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  SLACK_API_BASE_URL: z.string().url().default('https://slack.com/api/'),
  SLACK_UNFURL_ALLOWED_DOMAINS: z.string().optional(),
  ROUTER_DEBUG_CHANNEL_ID: z.string().optional(),
  // When adding an integration/instance secret below, also add it to
  // CONTROL_PLANE_ENV_VAR_NAMES (packages/types/src/control-plane-env-vars.ts)
  // unless it is already a `secret` field in a setup catalog, or it leaks into
  // task sandboxes.
  R_TEAMS_BOT_APP_ID: z.string().min(1).optional(),
  R_TEAMS_BOT_APP_PASSWORD: z.string().min(1).optional(),
  R_TEAMS_BOT_TENANT_ID: z.string().min(1).optional(),
  R_TEAMS_BOT_NAME: z.string().min(1).optional(),
  R_TEAMS_BOT_TOKEN_ENDPOINT: z.string().url().optional(),
  R_TEAMS_BOT_OAUTH_SCOPE: z.string().min(1).optional(),
  R_TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  R_TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
  TELEGRAM_API_BASE_URL: z.string().url().default('https://api.telegram.org'),
  R_MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  R_MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
  R_MICROSOFT_TENANT_ID: z.string().min(1).optional(),
  R_LINEAR_CLIENT_ID: z.string().min(1).optional(),
  R_LINEAR_CLIENT_SECRET: z.string().min(1).optional(),
  R_LINEAR_WEBHOOK_SECRET: z.string().min(1).optional(),
  R_LINEAR_REDIRECT_URI: z.string().min(1).optional(),
  DASHBOARD_PASSWORD: z.string().min(1),
  SETUP_TOKEN: z.string().min(1).optional(),
  // Dedicated Better Auth session-signing secret. Optional: falls back to
  // ENCRYPTION_KEY (see getBetterAuthSecret) when unset for backward compat.
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  ENCRYPTION_KEY: z.string().min(32),
  ARTIFACT_SIGNING_KEY: z.string().min(32),
  ARTIFACT_SIGNING_KEY_PREVIOUS: z.string().min(32).optional(),
  API_DEBUG_LOGS: z.string().optional(),
  SLACK_DEBUG_LOGS: z.string().optional(),
  S3_ENDPOINT: z.string().min(1),
  S3_PRESIGN_ENDPOINT: z.string().min(1).optional(),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_ARTIFACTS: z.string().min(1),
  S3_AUTO_CREATE_BUCKET: z.string().optional(),
  PREVIEW_PROXY_BASE_URL: emptyStringDefault(),
  WEB_DEV_LOGIN_EMAIL: z.string().optional(),
  // Explicit opt-in for the /auth/dev-login backdoor. Required in addition to
  // a development app env so implicit-development deployments never expose it.
  WEB_DEV_LOGIN_ENABLED: z.string().optional(),
  MODAL_TOKEN_ID: z.string().optional(),
  MODAL_TOKEN_SECRET: z.string().optional(),
  MODAL_ENDPOINT: z.string().optional(),
  MODAL_ENVIRONMENT: z.string().optional(),
  MODAL_APP_NAME: z.string().optional(),
  MODAL_BASE_IMAGE_REF: z.string().optional(),
  MODAL_REGISTRY_USERNAME: z.string().optional(),
  MODAL_REGISTRY_PASSWORD: z.string().optional(),
  MODAL_ECR_OIDC_ROLE_ARN: z.string().optional(),
  MODAL_ECR_REGION: z.string().optional(),
  MODAL_REGIONS: z.string().optional(),
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_API_URL: z.string().url().optional(),
  DAYTONA_TARGET: z.string().optional(),
  DAYTONA_SNAPSHOT_NAME: z.string().optional(),
  E2B_API_KEY: z.string().optional(),
  BL_API_KEY: z.string().optional(),
  BL_WORKSPACE: z.string().optional(),
  BLAXEL_IMAGE: z.string().optional(),
  BLAXEL_REGION: z.string().optional(),
  E2B_DOMAIN: z.string().optional(),
  E2B_TEMPLATE_ID: z.string().optional(),
  // E2B caps sandbox lifetime per plan (1 hour on Hobby, 24 hours on Pro);
  // requesting more fails sandbox creation with a 400, so the controller
  // clamps the provider-side timeout to this ceiling. Raise it only when the
  // E2B plan allows longer-lived sandboxes.
  E2B_MAX_SANDBOX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600_000),
  GITHUB_AUTOMATED_SKIP_REPOS: z.string().optional(),
  GITHUB_AUTOMATED_SKIP_OWNERS: z.string().optional(),
  PREVIEW_DOMAINS: emptyStringDefault(),
  R_ALLOWED_EMAILS: z.string().optional(),
  PREVIEW_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  SLACK_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // How long recorded webhook payloads are kept before the WebhookCleanup
  // scheduled job (apps/bullmq) deletes them.
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  API_EXTERNAL_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  API_SLOW_REQUEST_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
  API_SLOW_EXTERNAL_REQUEST_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_000),
};

export const ROOMOTE_SERVICE_VALUES = [
  'web',
  'api',
  'controller',
  'bullmq',
  'preview-proxy',
  'db-migrate',
] as const;

export type RoomoteService = (typeof ROOMOTE_SERVICE_VALUES)[number];

type ServerEnvKey = keyof typeof serverSchema;

const REQUIRED_SERVER_ENV_KEYS = new Set<ServerEnvKey>([
  'R_APP_URL',
  'TRPC_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'DASHBOARD_PASSWORD',
  'ENCRYPTION_KEY',
  'ARTIFACT_SIGNING_KEY',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_BUCKET_ARTIFACTS',
]);

/**
 * Required non-optional values for each production process. Optional
 * integration/provider settings keep their normal schemas and defaults, but a
 * process no longer has to receive unrelated core secrets merely to satisfy
 * the shared environment parser.
 */
export const SERVICE_REQUIRED_SERVER_ENV_KEYS = {
  web: [...REQUIRED_SERVER_ENV_KEYS],
  api: [
    'R_APP_URL',
    'TRPC_URL',
    'DATABASE_URL',
    'REDIS_URL',
    'ENCRYPTION_KEY',
    'ARTIFACT_SIGNING_KEY',
    'DASHBOARD_PASSWORD',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_BUCKET_ARTIFACTS',
  ],
  controller: [
    'R_APP_URL',
    'TRPC_URL',
    'DATABASE_URL',
    'REDIS_URL',
    'ENCRYPTION_KEY',
  ],
  bullmq: [
    'R_APP_URL',
    'DATABASE_URL',
    'REDIS_URL',
    'DASHBOARD_PASSWORD',
    'ENCRYPTION_KEY',
  ],
  'preview-proxy': ['R_APP_URL', 'DATABASE_URL', 'REDIS_URL'],
  'db-migrate': ['DATABASE_URL'],
} as const satisfies Record<RoomoteService, readonly ServerEnvKey[]>;

function resolveRoomoteService(
  value: string | undefined,
): RoomoteService | undefined {
  return ROOMOTE_SERVICE_VALUES.find((service) => service === value);
}

function buildServiceServerSchema(
  service: RoomoteService | undefined,
): typeof serverSchema {
  if (!service) {
    return serverSchema;
  }

  const requiredForService = new Set<ServerEnvKey>(
    SERVICE_REQUIRED_SERVER_ENV_KEYS[service],
  );

  return Object.fromEntries(
    Object.entries(serverSchema).map(([key, schema]) => [
      key,
      REQUIRED_SERVER_ENV_KEYS.has(key as ServerEnvKey) &&
      !requiredForService.has(key as ServerEnvKey)
        ? schema.optional()
        : schema,
    ]),
  ) as typeof serverSchema;
}

const clientSchema = {};

/** Keys whose runtime resolution requires more than a plain `resolve(key)`. */
const OVERRIDE_KEYS = new Set(['NODE_ENV', 'APP_ENV', 'SLACK_API_TIMEOUT_MS']);

const OPTIONAL_NON_EMPTY_KEYS = new Set([
  'DOCKER_WORKER_IMAGE',
  'R_APP_ENV',
  'R_PUBLIC_URL',
  'R_APP_URL',
  'R_AUTO_GENERATE_KEYS',
  'S3_AUTO_CREATE_BUCKET',
  'SANDBOX_OIDC_PRIVATE_KEY',
  'SANDBOX_OIDC_PUBLIC_KEY',
  'SANDBOX_OIDC_PUBLIC_KEY_SECONDARY',
  'GITHUB_MCP_SERVER_URL',
  'WORKER_RELEASE_CHANNEL',
  'WORKER_RELEASE_VERSION',
  'RELEASE_VERSION',
  'R_PING_BASE_URL',
  'SLACK_UNFURL_ALLOWED_DOMAINS',
  'ROUTER_DEBUG_CHANNEL_ID',
  'R_TEAMS_BOT_APP_ID',
  'R_TEAMS_BOT_APP_PASSWORD',
  'R_TEAMS_BOT_TENANT_ID',
  'R_TEAMS_BOT_NAME',
  'R_TEAMS_BOT_TOKEN_ENDPOINT',
  'R_TEAMS_BOT_OAUTH_SCOPE',
  'R_TELEGRAM_BOT_TOKEN',
  'R_TELEGRAM_WEBHOOK_SECRET',
  'R_SLACK_CLIENT_ID',
  'R_SLACK_CLIENT_SECRET',
  'R_SLACK_SIGNING_SECRET',
  'R_MICROSOFT_CLIENT_ID',
  'R_MICROSOFT_CLIENT_SECRET',
  'R_MICROSOFT_TENANT_ID',
  'R_LINEAR_CLIENT_ID',
  'R_LINEAR_CLIENT_SECRET',
  'R_LINEAR_WEBHOOK_SECRET',
  'R_LINEAR_REDIRECT_URI',
  'ARTIFACT_SIGNING_KEY_PREVIOUS',
  'SETUP_TOKEN',
  'API_DEBUG_LOGS',
  'SLACK_DEBUG_LOGS',
  'S3_ENDPOINT',
  'S3_PRESIGN_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_BUCKET_ARTIFACTS',
  'WEB_DEV_LOGIN_EMAIL',
  'WEB_DEV_LOGIN_ENABLED',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  'MODAL_ENDPOINT',
  'MODAL_ENVIRONMENT',
  'MODAL_APP_NAME',
  'MODAL_BASE_IMAGE_REF',
  'MODAL_REGISTRY_USERNAME',
  'MODAL_REGISTRY_PASSWORD',
  'MODAL_ECR_OIDC_ROLE_ARN',
  'MODAL_ECR_REGION',
  'MODAL_REGIONS',
  'DAYTONA_API_KEY',
  'DAYTONA_API_URL',
  'DAYTONA_TARGET',
  'DAYTONA_SNAPSHOT_NAME',
  'E2B_API_KEY',
  'BL_API_KEY',
  'BL_WORKSPACE',
  'BLAXEL_IMAGE',
  'BLAXEL_REGION',
  'E2B_DOMAIN',
  'E2B_TEMPLATE_ID',
  'E2B_MAX_SANDBOX_TIMEOUT_MS',
  'DOCKER_WORKER_NETWORK',
  'DOCKER_WORKER_RELEASE_PATH',
  'GITHUB_AUTOMATED_SKIP_REPOS',
  'GITHUB_AUTOMATED_SKIP_OWNERS',
  'R_MODEL',
  'R_SMALL_MODEL',
  'R_VISION_MODEL',
  'R_CODE_REVIEW_MODEL',
  'R_EXPLORE_MODEL',
  'R_PLANNING_MODEL',
  'R_MODEL_REASONING_EFFORT',
  'R_SMALL_MODEL_REASONING_EFFORT',
  'R_VISION_MODEL_REASONING_EFFORT',
  'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
  'R_EXPLORE_MODEL_REASONING_EFFORT',
  'R_PLANNING_MODEL_REASONING_EFFORT',
  'R_MODEL_ENV_KEYS',
  'R_ALLOWED_EMAILS',
  'R_GITHUB_APP_SLUG',
]);

/**
 * The base64-encoded P-256 keypair env keys that every deployment needs for
 * run-token and preview-token signing/verification.
 */
export const AUTH_KEYPAIR_ENV_KEYS = [
  'JOB_AUTH_PRIVATE_KEY',
  'JOB_AUTH_PUBLIC_KEY',
  'PREVIEW_AUTH_PRIVATE_KEY',
  'PREVIEW_AUTH_PUBLIC_KEY',
] as const;

export type AuthKeypairEnvKey = (typeof AUTH_KEYPAIR_ENV_KEYS)[number];

/** Parses an opt-in boolean env flag: `true` or `1`, case-insensitive. */
export function isEnvFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

/**
 * Whether the deployment opted into generating missing auth keypairs at boot
 * and persisting them in the database (`R_AUTO_GENERATE_KEYS=true`).
 */
export function isAutoGenerateKeysEnabled(value: string | undefined): boolean {
  return isEnvFlagEnabled(value);
}

/**
 * Whether missing auth keypairs are generated-and-persisted at boot: when
 * `R_AUTO_GENERATE_KEYS=true`, or implicitly for `APP_ENV=development`
 * (excluding `NODE_ENV=test`, so importing a service entrypoint in a unit test
 * does not trigger database work). Production and preview must supply real keys.
 */
export function shouldAutoGenerateAuthKeypairs(
  processEnv: NodeJS.ProcessEnv,
): boolean {
  if (isAutoGenerateKeysEnabled(processEnv.R_AUTO_GENERATE_KEYS)) {
    return true;
  }
  return (
    resolveAppEnv(processEnv) === 'development' &&
    processEnv.NODE_ENV !== 'test'
  );
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Whether `HOST` binds an interface reachable beyond the local machine. Unset
 * (as under `pnpm dev`) counts as local; containers set it to `0.0.0.0`.
 */
export function isExposedBindHost(host: string | undefined): boolean {
  const normalized = host?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return !LOOPBACK_HOSTS.has(normalized);
}

interface InsecureLocalSecretEnv {
  ENCRYPTION_KEY?: string;
  ARTIFACT_SIGNING_KEY?: string;
  DASHBOARD_PASSWORD?: string;
}

/** Names of the committed local-default secrets currently in effect. */
export function getActiveInsecureLocalSecrets(
  env: InsecureLocalSecretEnv,
): string[] {
  const active: string[] = [];
  if (env.ENCRYPTION_KEY === LOCAL_ENCRYPTION_KEY) {
    active.push('ENCRYPTION_KEY');
  }
  if (env.ARTIFACT_SIGNING_KEY === LOCAL_ARTIFACT_SIGNING_KEY) {
    active.push('ARTIFACT_SIGNING_KEY');
  }
  if (env.DASHBOARD_PASSWORD === LOCAL_DASHBOARD_PASSWORD) {
    active.push('DASHBOARD_PASSWORD');
  }
  return active;
}

/**
 * Fail-closed boot guard: refuse to start when a committed local-default secret
 * is in effect while `HOST` binds a non-loopback interface. Override with
 * `ROOMOTE_ALLOW_INSECURE_LOCAL_KEYS=1`. Call from each service entrypoint.
 */
export function assertSecureBootBinding(
  options: {
    env?: InsecureLocalSecretEnv;
    processEnv?: NodeJS.ProcessEnv;
  } = {},
): void {
  const processEnv = options.processEnv ?? process.env;

  if (isEnvFlagEnabled(processEnv.ROOMOTE_ALLOW_INSECURE_LOCAL_KEYS)) {
    return;
  }

  if (!isExposedBindHost(processEnv.HOST)) {
    return;
  }

  const env = options.env ?? getSharedEnv();
  const active = getActiveInsecureLocalSecrets(env);
  if (active.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to start: ${active.join(', ')} still use the built-in local ` +
      `development default(s) while HOST=${processEnv.HOST} binds a ` +
      'non-loopback interface. These defaults are public in the Roomote ' +
      'source and must not protect an exposed deployment. Supply real ' +
      'secrets (deploy/install.sh generates them, or layer ' +
      'docker-compose.production.yml), bind HOST to localhost, or set ' +
      'ROOMOTE_ALLOW_INSECURE_LOCAL_KEYS=1 to override for trusted local use.',
  );
}

type AuthKeypairEnv = Partial<Record<AuthKeypairEnvKey, string>> & {
  R_AUTO_GENERATE_KEYS?: string;
  APP_ENV?: string;
};

const SERVICE_AUTH_KEYPAIR_ENV_KEYS = {
  web: AUTH_KEYPAIR_ENV_KEYS,
  api: ['JOB_AUTH_PRIVATE_KEY', 'JOB_AUTH_PUBLIC_KEY'],
  controller: ['JOB_AUTH_PRIVATE_KEY', 'JOB_AUTH_PUBLIC_KEY'],
  bullmq: [],
  'preview-proxy': ['JOB_AUTH_PUBLIC_KEY', 'PREVIEW_AUTH_PUBLIC_KEY'],
  'db-migrate': [],
} as const satisfies Record<RoomoteService, readonly AuthKeypairEnvKey[]>;

function assertAuthKeypairEnv(
  env: AuthKeypairEnv,
  service: RoomoteService | undefined,
) {
  // Development auto-generates missing keypairs at boot (see
  // shouldAutoGenerateAuthKeypairs); production and preview must supply them.
  if (
    isAutoGenerateKeysEnabled(env.R_AUTO_GENERATE_KEYS) ||
    env.APP_ENV === 'development'
  ) {
    return;
  }

  const requiredKeys = service
    ? SERVICE_AUTH_KEYPAIR_ENV_KEYS[service]
    : AUTH_KEYPAIR_ENV_KEYS;
  const missingKeys = requiredKeys.filter((key) => !env[key]?.trim());

  if (missingKeys.length === 0) {
    return;
  }

  throw new Error(
    `${missingKeys.join(', ')} must be configured. Provide base64-encoded ` +
      'P-256 PEM keys (see SELF_HOSTING.md), or set ' +
      'R_AUTO_GENERATE_KEYS=true to let Roomote generate the keypairs ' +
      'at first startup and persist them in the database.',
  );
}

type MicrosoftAuthEnv = {
  R_MICROSOFT_CLIENT_ID?: string;
  R_MICROSOFT_CLIENT_SECRET?: string;
  R_MICROSOFT_TENANT_ID?: string;
};

function assertCompleteMicrosoftAuthEnv(env: MicrosoftAuthEnv) {
  const keys = [
    'R_MICROSOFT_CLIENT_ID',
    'R_MICROSOFT_CLIENT_SECRET',
    'R_MICROSOFT_TENANT_ID',
  ] as const;
  const configuredKeys = keys.filter((key) => Boolean(env[key]));

  if (configuredKeys.length === 0 || configuredKeys.length === keys.length) {
    return;
  }

  const missingKeys = keys.filter((key) => !env[key]);
  throw new Error(
    `Microsoft auth requires ${missingKeys.join(', ')} when any R_MICROSOFT_* value is set.`,
  );
}

function buildRoomoteRuntimeEnv(
  processEnv: NodeJS.ProcessEnv,
  resolve: (key: string) => string | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  for (const key of [
    ...Object.keys(sharedSchema),
    ...Object.keys(serverSchema),
    ...Object.keys(clientSchema),
  ]) {
    if (!OVERRIDE_KEYS.has(key)) {
      const value = resolve(key);
      env[key] =
        OPTIONAL_NON_EMPTY_KEYS.has(key) && value === '' ? undefined : value;
    }
  }

  // Published app images bake RELEASE_VERSION, and the publish workflow
  // pushes the worker image with the identical tag. Deriving the worker
  // image from it spares self-host operators a manual multi-place version
  // bump on every upgrade; an explicit DOCKER_WORKER_IMAGE always wins, and
  // local/self-host builds fall through to the schema default.
  const resolvedDockerWorkerImage = resolveEffectiveDockerWorkerImage({
    DOCKER_WORKER_IMAGE: resolve('DOCKER_WORKER_IMAGE'),
    RELEASE_VERSION: resolve('RELEASE_VERSION'),
    ROOMOTE_WORKER_IMAGE_REPO: resolve('ROOMOTE_WORKER_IMAGE_REPO'),
  });

  env.DOCKER_WORKER_IMAGE =
    resolvedDockerWorkerImage ?? DEFAULT_LOCAL_DOCKER_WORKER_IMAGE;

  // Keys with non-trivial resolution logic:
  const nodeEnv = parseNodeEnv(resolve('NODE_ENV')) ?? 'development';
  env.NODE_ENV = nodeEnv;
  // APP_ENV is derived from multiple Vercel env vars, not a single key lookup.
  env.APP_ENV = resolveAppEnv(processEnv);
  env.SLACK_API_TIMEOUT_MS =
    resolve('SLACK_API_TIMEOUT_MS') ??
    resolve('API_EXTERNAL_REQUEST_TIMEOUT_MS');

  const appEnv = resolveAppEnv(processEnv);

  if (nodeEnv !== 'production' && appEnv === 'development') {
    env.R_APP_URL ??= getDefaultRoomoteAppUrl(appEnv);
    env.TRPC_URL ??= getDefaultTrpcUrl(appEnv);
    env.DATABASE_URL ??=
      nodeEnv === 'test'
        ? 'postgres://postgres:password@localhost:15432/roomote_test'
        : 'postgres://postgres:password@localhost:15432/roomote_development';
    env.REDIS_URL ??= 'redis://localhost:16379';
    // JOB_AUTH / PREVIEW_AUTH keypairs are auto-generated at boot, not defaulted.
    env.DASHBOARD_PASSWORD ??= LOCAL_DASHBOARD_PASSWORD;
    env.ENCRYPTION_KEY ??= LOCAL_ENCRYPTION_KEY;
    env.ARTIFACT_SIGNING_KEY ??= LOCAL_ARTIFACT_SIGNING_KEY;
    env.PREVIEW_PROXY_BASE_URL ??= getDefaultPreviewProxyBaseUrl(appEnv);
    env.PREVIEW_DOMAINS ??= LOCAL_PREVIEW_DOMAINS;
    env.S3_ENDPOINT ??= LOCAL_S3_ENDPOINT;
    env.S3_PRESIGN_ENDPOINT ??= LOCAL_S3_PRESIGN_ENDPOINT;
    env.S3_REGION ??= LOCAL_S3_REGION;
    env.S3_ACCESS_KEY_ID ??= LOCAL_S3_ACCESS_KEY_ID;
    env.S3_SECRET_ACCESS_KEY ??= LOCAL_S3_SECRET_ACCESS_KEY;
    env.S3_BUCKET_ARTIFACTS ??= LOCAL_S3_BUCKET_ARTIFACTS;
  }

  // Slack rejects the whole account-linking DM (invalid_blocks) when the
  // "Link accounts" button URL is not absolute, so an unset SLACK_AUTH_URI
  // must fall back to the web app's linking route rather than empty string.
  if (!env.SLACK_AUTH_URI && env.R_APP_URL) {
    env.SLACK_AUTH_URI = `${env.R_APP_URL.replace(/\/+$/, '')}/api/slack/auth`;
  }

  return env;
}

/**
 * Build a validated Roomote env object from the shared schema.
 *
 * @param processEnv - The backing `ProcessEnv` object. Used for `APP_ENV`
 *                     derivation (reads Vercel-specific vars) and to check
 *                     `SKIP_ENV_VALIDATION`.
 * @param resolve    - Value lookup function. Defaults to `processEnv[key]`.
 *                     Override this when raw values come from a different
 *                     backend (e.g. dotenvx decryption on Vercel previews).
 */
export function createRoomoteEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  resolve: (key: string) => string | undefined = (key) => processEnv[key],
) {
  const skipValidation = typeof processEnv.SKIP_ENV_VALIDATION !== 'undefined';
  const service = resolveRoomoteService(processEnv.ROOMOTE_SERVICE);

  const env = createEnv({
    shared: sharedSchema,
    server: buildServiceServerSchema(service),
    client: clientSchema,
    runtimeEnv: buildRoomoteRuntimeEnv(processEnv, resolve),
    skipValidation,
  });

  if (!skipValidation) {
    assertAuthKeypairEnv(env, service);
  }

  assertCompleteMicrosoftAuthEnv(env);

  return env;
}

type RoomoteEnv = ReturnType<typeof createRoomoteEnv>;

function createEnvProxy(getCurrentEnv: () => RoomoteEnv): RoomoteEnv {
  return new Proxy({} as RoomoteEnv, {
    get(_target, prop, receiver) {
      return Reflect.get(getCurrentEnv(), prop, receiver);
    },
    has(_target, prop) {
      return Reflect.has(getCurrentEnv(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(getCurrentEnv());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        getCurrentEnv(),
        prop,
      );

      if (!descriptor) {
        return descriptor;
      }

      return { ...descriptor, configurable: true };
    },
  });
}

let sharedEnv: RoomoteEnv | null = null;

function getSharedEnv(): RoomoteEnv {
  sharedEnv ??= createRoomoteEnv(process.env);
  return sharedEnv;
}

export function rehydrateEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): RoomoteEnv {
  sharedEnv = createRoomoteEnv(processEnv);
  return sharedEnv;
}

export const Env = createEnvProxy(getSharedEnv);

export * from './app-env';
export * from './runtime-bootstrap';
export * from './secrets';
