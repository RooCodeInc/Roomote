import { createEnv } from '@t3-oss/env-nextjs';
import {
  DEFAULT_LOCAL_DOCKER_WORKER_IMAGE,
  resolveEffectiveDockerWorkerImage,
  ROOMOTE_CLOUD_BACKENDS,
  TASK_SANDBOX_DOCKER_MEMORY_MIB,
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
const LOCAL_DISCORD_GATEWAY_SECRET = 'local-roomote-discord-gateway-secret-01';
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
    .enum(['modal', 'docker', 'daytona', 'e2b', 'box', 'roomote', 'azure'])
    .default('docker'),
  EXCLUDED_COMPUTE_PROVIDERS: z.string().optional(),
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
  DOCKER_TASK_DAEMON_MEMORY_LIMIT: dockerSize().default('8g'),
  // Headroom for browser-driving tasks: a Chrome process tree plus the
  // agent-browser daemon and worker toolchain runs well over the old 512 cap
  // under load. `--init` reaps zombies (see docker-sandbox-security), but the
  // live process count still needs room. Env-overridable.
  DOCKER_WORKER_PIDS_LIMIT: z.coerce.number().int().positive().default(2048),
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
  BOX_STANDBY_MAX_COUNT: z.coerce.number().int().nonnegative().optional(),
  BOX_STANDBY_MAX_AGE_HOURS: z.coerce.number().positive().optional(),
  R_PUBLIC_URL: z.string().url().optional(),
  R_APP_URL: z.string().min(1),
  // Anonymous telemetry + version checks (Ping service).
  R_PING_BASE_URL: z.string().url().default('https://ping.roomote.dev'),
  R_INSTANCE_ID: z
    .string()
    .min(6)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
  // Optional unresolved-incidents feed. Presence enables Statuspage checks.
  R_STATUSPAGE_INCIDENTS_URL: z.string().url().optional(),
  // Roomote Cloud-only analytics and support integrations. These values are
  // intentionally not used by self-hosted deployments.
  R_CLOUD_ENABLED: optInBoolean(),
  // Operator policy for the curated Settings > Integrations catalog. Enabled
  // by default; operators opt out explicitly. Existing connections remain
  // stored but cannot be configured or used while disabled.
  R_CURATED_INTEGRATIONS_DISABLED: optInBoolean(),
  // Operator kill switch for admin-configured custom MCP servers. Deliberately
  // independent of R_CURATED_INTEGRATIONS_DISABLED: operators who disable the
  // curated catalog are the primary custom-server audience.
  R_CUSTOM_MCP_DISABLED: optInBoolean(),
  // Comma-separated CIDR ranges the custom-MCP egress guard may connect to in
  // addition to public addresses. Self-host escape hatch for MCP servers on
  // private networks; a CIDR list rather than a boolean so opening one
  // internal host does not re-expose every adjacent service.
  R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS: z.string().min(1).optional(),
  // ElevenLabs credentials for the narration TTS endpoint. The key stays on
  // the control plane; task sandboxes reach TTS only through /api/tts with
  // their run-scoped token (see apps/api/src/handlers/tts). Unset means the
  // feature is off and the endpoint 404s.
  R_ELEVENLABS_API_KEY: z.string().min(1).optional(),
  R_ELEVENLABS_VOICE_ID: z.string().min(1).optional(),
  R_INTERCOM_APP_ID: z.string().min(1).optional(),
  R_POSTHOG_PROJECT_KEY: z.string().min(1).optional(),
  R_POSTHOG_HOST: z.string().url().optional(),
  // Force-enable telemetry in environments that would otherwise stay silent
  // (development / builds without RELEASE_VERSION). Testing escape hatch.
  ROOMOTE_FORCE_TELEMETRY: z.string().optional(),
  // Release tag baked into published app images by the publish workflow.
  RELEASE_VERSION: z.string().min(1).optional(),
  // Product (changelog) version baked into published app images alongside
  // RELEASE_VERSION, so channel builds (develop-<sha>/main-<sha>) still know
  // which product release they contain. Read by the in-app release notices.
  RELEASE_PRODUCT_VERSION: z.string().min(1).optional(),
  TRPC_URL: z.string().min(1),
  R_MODEL: z.string().min(1).optional(),
  R_ORCHESTRATION_MODEL: z.string().min(1).optional(),
  R_SMALL_MODEL: z.string().min(1).optional(),
  R_VISION_MODEL: z.string().min(1).optional(),
  R_CODE_REVIEW_MODEL: z.string().min(1).optional(),
  R_EXPLORE_MODEL: z.string().min(1).optional(),
  R_PLANNING_MODEL: z.string().min(1).optional(),
  R_MODEL_REASONING_EFFORT: z.string().min(1).optional(),
  R_ORCHESTRATION_MODEL_REASONING_EFFORT: z.string().min(1).optional(),
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
  R_GITHUB_ADDITIONAL_APP_SLUGS: z.string().optional(),
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
  R_AGENTMAIL_API_KEY: z.string().min(1).optional(),
  R_AGENTMAIL_WEBHOOK_SECRET: z.string().min(1).optional(),
  R_AGENTMAIL_INBOX_ID: z.string().min(1).optional(),
  AGENTMAIL_API_BASE_URL: z.string().url().default('https://api.agentmail.to'),
  R_DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  R_DISCORD_GATEWAY_SECRET: z.string().min(1).optional(),
  DISCORD_API_BASE_URL: z.string().url().default('https://discord.com/api/v10'),
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
  // Deployment-managed Roomote Cloud credentials (Modal machinery, seeded by
  // the hosting operator's provisioning rather than the setup flow).
  ROOMOTE_CLOUD_TOKEN_ID: z.string().optional(),
  ROOMOTE_CLOUD_TOKEN_SECRET: z.string().optional(),
  ROOMOTE_CLOUD_ACCESS_VERIFICATION_SECRET: z.string().optional(),
  ROOMOTE_CLOUD_BACKEND: z.enum(ROOMOTE_CLOUD_BACKENDS).optional(),
  ROOMOTE_CLOUD_SLUG: z.string().optional(),
  ROOMOTE_CLOUD_APP_NAME: z.string().optional(),
  // Compute broker base URL for the `broker` backend; with it, the token
  // pair above carries a derived per-tenant broker credential instead of
  // Modal workspace tokens.
  ROOMOTE_CLOUD_BROKER_URL: z.string().url().optional(),
  MODAL_ENDPOINT: z.string().optional(),
  MODAL_ENVIRONMENT: z.string().optional(),
  MODAL_APP_NAME: z.string().optional(),
  MODAL_BASE_IMAGE_REF: z.string().optional(),
  MODAL_REGISTRY_USERNAME: z.string().optional(),
  MODAL_REGISTRY_PASSWORD: z.string().optional(),
  MODAL_ECR_OIDC_ROLE_ARN: z.string().optional(),
  MODAL_ECR_REGION: z.string().optional(),
  MODAL_REGIONS: z.string().optional(),
  MODAL_VM_MEMORY_MIB: z.coerce
    .number()
    .int()
    .positive()
    .default(TASK_SANDBOX_DOCKER_MEMORY_MIB),
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_API_URL: z.string().url().optional(),
  DAYTONA_TARGET: z.string().optional(),
  DAYTONA_SNAPSHOT_NAME: z.string().optional(),
  E2B_API_KEY: z.string().optional(),
  BL_API_KEY: z.string().optional(),
  BL_WORKSPACE: z.string().optional(),
  BLAXEL_IMAGE: z.string().optional(),
  BLAXEL_REGION: z.string().optional(),
  BOX_API_KEY: z.string().min(1).optional(),
  BOX_API_BASE_URL: z.string().url().optional(),
  BOX_MACHINE_TYPE: z.enum(['small', 'default', 'large']).optional(),
  BOX_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  E2B_DOMAIN: z.string().optional(),
  E2B_TEMPLATE_ID: z.string().optional(),
  AZURE_SUBSCRIPTION_ID: z.string().optional(),
  AZURE_RESOURCE_GROUP: z.string().optional(),
  AZURE_SANDBOX_GROUP: z.string().optional(),
  AZURE_SANDBOX_REGION: z.string().optional(),
  AZURE_SANDBOX_DISK_IMAGE: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  AZURE_SANDBOX_REGISTRY_USERNAME: z.string().optional(),
  AZURE_SANDBOX_REGISTRY_TOKEN: z.string().optional(),
  AZURE_SANDBOX_SIZE: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
  AZURE_SANDBOX_EGRESS_INSPECTION: z
    .enum(['Legacy', 'Full', 'Partial', 'None'])
    .optional(),
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
  // Optional Roomote license key (RMLK1.…). When set, takes precedence over
  // the key stored in deployment_settings via Settings → Users.
  R_LICENSE_KEY: z.string().optional(),
  // Roomote Cloud endpoint used to activate self-hosted licenses and report
  // licensed seat usage. This is deliberately distinct from Ping telemetry.
  R_LICENSE_CLOUD_BASE_URL: z
    .string()
    .url()
    .default('https://cloud.roomote.dev'),
  PREVIEW_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  SLACK_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // How long recorded webhook payloads are kept before the WebhookCleanup
  // scheduled job (apps/bullmq) deletes them.
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(3),
  // Internal base URL of the deployment-hosted gbrain (Brain)
  // service. Unset means the feature is unavailable regardless of the
  // brain_settings row; the proxy and outbox drainer both no-op.
  R_GBRAIN_URL: z.string().url().optional(),
  // Bearer token for gbrain's /ingest webhook, held by ingestion workers
  // only. The agent-facing proxy never uses this credential.
  R_GBRAIN_INGEST_TOKEN: z.string().min(1).optional(),
  // Read-only bearer token the API proxy presents to gbrain for agent
  // queries. Distinct credential class from the ingest token by design: a
  // compromised agent path must be structurally incapable of writes.
  R_GBRAIN_AGENT_TOKEN: z.string().min(1).optional(),
  // Admin-scoped bearer token used only by the scheduler to enqueue gbrain's
  // built-in maintenance cycle. Normally Roomote provisions this itself.
  R_GBRAIN_MAINTENANCE_TOKEN: z.string().min(1).optional(),
  // gbrain's admin bootstrap token, given directly or as a file path (the
  // compose profile mounts the gbrain volume read-only and points this at
  // the token the entrypoint generates). Roomote uses it once, headlessly,
  // to register its own scoped clients.
  R_GBRAIN_ADMIN_TOKEN: z.string().min(1).optional(),
  R_GBRAIN_ADMIN_TOKEN_FILE: z.string().min(1).optional(),
  // THE Brain activation signal. Supplying an OpenRouter key for the Brain
  // turns the feature on: the key powers the brain's embeddings (semantic
  // recall), and its presence is what tells Roomote this deployment has a
  // Brain to provision, deliver to agents, and feed. No Settings UI, no
  // enablement row — infrastructure, not an integration.
  R_BRAIN_OPENROUTER_API_KEY: z.string().min(1).optional(),
  // Alternative to the above for deployments that would rather talk to
  // OpenAI directly than route through OpenRouter. Either key activates the
  // Brain; the models both default to are OpenAI's either way, so this only
  // changes who bills for them. If both are set, OpenRouter wins, so adding
  // an OpenAI key for something else never silently re-points an existing
  // Brain at a different embedding path.
  R_BRAIN_OPENAI_API_KEY: z.string().min(1).optional(),
  // Free-trial OpenRouter credential a hosting provisioner injects for new
  // cloud deployments: a Roomote-minted key with a hard spend limit. The env
  // variable is only hosting's delivery mechanism — setup imports its value
  // into encrypted Settings storage, and every runtime read (inference
  // gateway, credit balance, provider status) resolves the stored key, never
  // this variable. Activating the trial is an explicit operator choice in
  // the setup wizard; deleting the Roomote provider in Settings removes the
  // stored key and disables the trial even while hosting keeps injecting
  // this variable. Rotating the injected value re-imports it only while the
  // stored key still exists. Served through the inference gateway like any
  // other provider key, so it never reaches a sandbox.
  R_TRIAL_OPENROUTER_API_KEY: z.string().min(1).optional(),
  // Optional self-run inference upstreams for the Brain gateway. When set,
  // the gateway routes that path's requests there instead of the configured
  // model provider — embeddings can move to a local or fleet
  // inference service while chat synthesis keeps flowing to the provider.
  // Model names pass through unrewritten: the upstream owns its own names.
  R_BRAIN_EMBEDDINGS_UPSTREAM_URL: z.string().url().optional(),
  // One key for both paths: they are the same service in every planned
  // deployment shape. Optional because a compose-network upstream may have
  // no auth at all.
  R_BRAIN_INFERENCE_UPSTREAM_API_KEY: z.string().min(1).optional(),
  // Shared secret between this deployment and its Brain container, so the
  // Brain can reach /api/brain/inference without holding a provider key of
  // its own. It is the Brain's whole credential: the real provider key stays
  // here, wherever an admin configured it, and can change without the Brain
  // restarting or ever seeing it.
  R_BRAIN_GATEWAY_TOKEN: z.string().min(1).optional(),
  // Same shape as R_GBRAIN_ADMIN_TOKEN_FILE: on Compose the Brain generates
  // this on its own volume and the app reads it through a read-only mount, so
  // a stack brought up by hand needs no shared secret in the repo and no
  // second value for an operator to remember.
  R_BRAIN_GATEWAY_TOKEN_FILE: z.string().min(1).optional(),
  // Which models the Brain runs, in the configured provider's own naming
  // (`openai/gpt-5.6-luna` on OpenRouter, `gpt-5.6-luna` on OpenAI). Both are
  // substituted by the gateway, so changing the synthesis model is a restart
  // of nothing at all.
  R_BRAIN_MODEL: z.string().min(1).optional(),
  // Create-time, unlike the above. The embedding model's output width sizes
  // the Brain's vector column when the Brain is first created, and gbrain
  // cannot widen it afterwards without rebuilding and re-embedding. Set this
  // together with R_BRAIN_EMBEDDING_DIMENSIONS, before the Brain's first
  // boot, or leave both unset.
  R_BRAIN_EMBEDDING_MODEL: z.string().min(1).optional(),
  R_BRAIN_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
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
  'R_GBRAIN_URL',
  'R_GBRAIN_INGEST_TOKEN',
  'R_GBRAIN_AGENT_TOKEN',
  'R_GBRAIN_MAINTENANCE_TOKEN',
  'R_GBRAIN_ADMIN_TOKEN',
  'R_GBRAIN_ADMIN_TOKEN_FILE',
  'R_BRAIN_OPENROUTER_API_KEY',
  'R_BRAIN_OPENAI_API_KEY',
  'R_TRIAL_OPENROUTER_API_KEY',
  'R_BRAIN_EMBEDDINGS_UPSTREAM_URL',
  'R_BRAIN_INFERENCE_UPSTREAM_API_KEY',
  'R_BRAIN_GATEWAY_TOKEN',
  'R_BRAIN_GATEWAY_TOKEN_FILE',
  'R_BRAIN_MODEL',
  'R_BRAIN_EMBEDDING_MODEL',
  'R_BRAIN_EMBEDDING_DIMENSIONS',
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
  'RELEASE_PRODUCT_VERSION',
  'R_PING_BASE_URL',
  'R_INSTANCE_ID',
  'R_STATUSPAGE_INCIDENTS_URL',
  'R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS',
  'R_ELEVENLABS_API_KEY',
  'R_ELEVENLABS_VOICE_ID',
  'R_INTERCOM_APP_ID',
  'R_POSTHOG_PROJECT_KEY',
  'R_POSTHOG_HOST',
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
  'R_AGENTMAIL_API_KEY',
  'R_AGENTMAIL_WEBHOOK_SECRET',
  'R_AGENTMAIL_INBOX_ID',
  'R_DISCORD_BOT_TOKEN',
  'R_DISCORD_GATEWAY_SECRET',
  'DISCORD_API_BASE_URL',
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
  'ROOMOTE_CLOUD_TOKEN_ID',
  'ROOMOTE_CLOUD_TOKEN_SECRET',
  'ROOMOTE_CLOUD_ACCESS_VERIFICATION_SECRET',
  'ROOMOTE_CLOUD_BACKEND',
  'ROOMOTE_CLOUD_SLUG',
  'ROOMOTE_CLOUD_APP_NAME',
  'MODAL_ENDPOINT',
  'MODAL_ENVIRONMENT',
  'MODAL_APP_NAME',
  'MODAL_BASE_IMAGE_REF',
  'MODAL_REGISTRY_USERNAME',
  'MODAL_REGISTRY_PASSWORD',
  'MODAL_ECR_OIDC_ROLE_ARN',
  'MODAL_ECR_REGION',
  'MODAL_REGIONS',
  'MODAL_VM_MEMORY_MIB',
  'DAYTONA_API_KEY',
  'DAYTONA_API_URL',
  'DAYTONA_TARGET',
  'DAYTONA_SNAPSHOT_NAME',
  'E2B_API_KEY',
  'BL_API_KEY',
  'BL_WORKSPACE',
  'BLAXEL_IMAGE',
  'BLAXEL_REGION',
  'BOX_API_KEY',
  'BOX_API_BASE_URL',
  'BOX_MACHINE_TYPE',
  'BOX_TIMEOUT_MS',
  'BOX_STANDBY_MAX_COUNT',
  'BOX_STANDBY_MAX_AGE_HOURS',
  'E2B_DOMAIN',
  'E2B_TEMPLATE_ID',
  'E2B_MAX_SANDBOX_TIMEOUT_MS',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_RESOURCE_GROUP',
  'AZURE_SANDBOX_GROUP',
  'AZURE_SANDBOX_REGION',
  'AZURE_SANDBOX_DISK_IMAGE',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SANDBOX_REGISTRY_USERNAME',
  'AZURE_SANDBOX_REGISTRY_TOKEN',
  'AZURE_SANDBOX_SIZE',
  'AZURE_SANDBOX_EGRESS_INSPECTION',
  'DOCKER_WORKER_NETWORK',
  'DOCKER_WORKER_RELEASE_PATH',
  'GITHUB_AUTOMATED_SKIP_REPOS',
  'GITHUB_AUTOMATED_SKIP_OWNERS',
  'R_MODEL',
  'R_ORCHESTRATION_MODEL',
  'R_SMALL_MODEL',
  'R_VISION_MODEL',
  'R_CODE_REVIEW_MODEL',
  'R_EXPLORE_MODEL',
  'R_PLANNING_MODEL',
  'R_MODEL_REASONING_EFFORT',
  'R_ORCHESTRATION_MODEL_REASONING_EFFORT',
  'R_SMALL_MODEL_REASONING_EFFORT',
  'R_VISION_MODEL_REASONING_EFFORT',
  'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
  'R_EXPLORE_MODEL_REASONING_EFFORT',
  'R_PLANNING_MODEL_REASONING_EFFORT',
  'R_MODEL_ENV_KEYS',
  'R_ALLOWED_EMAILS',
  'R_LICENSE_KEY',
  'R_LICENSE_CLOUD_BASE_URL',
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

/** Whether Roomote Cloud-only behavior is enabled for this deployment. */
export function isRoomoteCloudEnabled(
  value: string | boolean | undefined,
): boolean {
  return (
    value === true || (typeof value === 'string' && isEnvFlagEnabled(value))
  );
}

/**
 * Whether the operator has switched off curated integrations on this
 * deployment. Enabled unless explicitly disabled.
 */
/**
 * Whether this deployment *might* have a Brain: some Brain wiring exists in
 * the environment. This is deliberately a superset question, not activation.
 * Deployment templates supply the gateway token directly or by file as
 * plumbing between the gbrain service and the inference gateway, so either
 * signal means "a Brain could be wired here", never "an operator turned the
 * Brain on". Activation — everything user-visible, from delivering the
 * gbrain MCP server to agents to running ingestion — additionally requires
 * the Brain to be enabled: the `brainEnabled` Settings toggle, falling back
 * to an explicit R_BRAIN_* provider key for deployments that opted in
 * before the toggle existed. That predicate lives in isBrainEnabled
 * (@roomote/db).
 *
 * Not R_GBRAIN_URL, which every compose file defaults to a service address
 * whether or not that service runs. Keying on a defaulted value made this
 * true everywhere and quietly enqueued memories on deployments that have no
 * Brain and never will.
 *
 * The split exists because this gates the cheap, synchronous paths that only
 * need to know a Brain might exist, above all the outbox insert inside the
 * run-completion transaction, which must not do a database lookup of its
 * own. Enqueuing memories for a Brain that is not enabled yet is
 * intentional: the drainer holds them until it is, so turning the Brain on
 * later picks up the history rather than starting from that moment.
 */
export function isBrainConfigured(env: {
  R_BRAIN_GATEWAY_TOKEN?: string;
  R_BRAIN_GATEWAY_TOKEN_FILE?: string;
  R_BRAIN_OPENROUTER_API_KEY?: string;
  R_BRAIN_OPENAI_API_KEY?: string;
  R_BRAIN_EMBEDDINGS_UPSTREAM_URL?: string;
  R_BRAIN_INFERENCE_UPSTREAM_API_KEY?: string;
}): boolean {
  return Boolean(
    env.R_BRAIN_GATEWAY_TOKEN?.trim() ||
    env.R_BRAIN_GATEWAY_TOKEN_FILE?.trim() ||
    env.R_BRAIN_OPENROUTER_API_KEY?.trim() ||
    env.R_BRAIN_OPENAI_API_KEY?.trim(),
  );
}

export function areCuratedIntegrationsDisabled(
  value: string | boolean | undefined,
): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  return value === true;
}

/**
 * Whether the deployment opted out of admin-configured custom MCP servers.
 * Same normalization contract as areCuratedIntegrationsDisabled.
 */
export function isCustomMcpDisabled(
  value: string | boolean | undefined,
): boolean {
  return areCuratedIntegrationsDisabled(value);
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
    env.R_DISCORD_GATEWAY_SECRET ??= LOCAL_DISCORD_GATEWAY_SECRET;
    // Keep process.env aligned so API auth, BullMQ, and the gateway share the
    // same local default instead of only one process reading Env.*.
    if (!processEnv.R_DISCORD_GATEWAY_SECRET?.trim()) {
      processEnv.R_DISCORD_GATEWAY_SECRET = env.R_DISCORD_GATEWAY_SECRET;
    }
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
  // Prefer R_PUBLIC_URL when set so fleets with a loopback R_APP_URL still
  // advertise a browser-reachable account-link URL.
  const slackAuthOrigin = env.R_PUBLIC_URL ?? env.R_APP_URL;
  if (!env.SLACK_AUTH_URI && slackAuthOrigin) {
    let appUrl = slackAuthOrigin;
    while (appUrl.endsWith('/')) {
      appUrl = appUrl.slice(0, -1);
    }
    env.SLACK_AUTH_URI = `${appUrl}/api/slack/auth`;
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
