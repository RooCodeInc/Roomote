import {
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  parseModelProviderEnvKeys,
} from '@roomote/types';

/**
 * Service-level configuration a non-task OpenCode helper process does not use.
 *
 * The helper is a model client. Roomote's native tools call back to the
 * launching service over the tool bridge, so the helper itself only needs
 * model-provider credentials and the variables passed to it explicitly.
 * Mirrors the intent of the task sandbox block-list in
 * `@roomote/compute-providers` (`BLOCKED_WORKER_ENV_KEYS`).
 */
const HELPER_BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set([
  // Data stores.
  'DATABASE_URL',
  'REDIS_URL',
  'ENCRYPTION_KEY',
  // Signing keys.
  'JOB_AUTH_PRIVATE_KEY',
  'PREVIEW_AUTH_PRIVATE_KEY',
  'SANDBOX_OIDC_PRIVATE_KEY',
  'ARTIFACT_SIGNING_KEY',
  'ARTIFACT_SIGNING_KEY_PREVIOUS',
  'BETTER_AUTH_SECRET',
  // Operator and control-plane configuration.
  'DASHBOARD_PASSWORD',
  'SETUP_TOKEN',
  'R_LICENSE_KEY',
  'ROOMOTE_CLOUD_TOKEN_ID',
  'ROOMOTE_CLOUD_TOKEN_SECRET',
  // Storage and compute-provider credentials.
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  'AZURE_SANDBOX_REGISTRY_TOKEN',
  'DAYTONA_API_KEY',
  'E2B_API_KEY',
  'BL_API_KEY',
  'BOX_API_KEY',
  // Integration credentials used by the launching service.
  'R_GITHUB_APP_PRIVATE_KEY',
  'R_DISCORD_BOT_TOKEN',
  'R_TELEGRAM_BOT_TOKEN',
  'R_AGENTMAIL_API_KEY',
  'R_BRAIN_GATEWAY_TOKEN',
  'R_GBRAIN_ADMIN_TOKEN',
  'R_GBRAIN_AGENT_TOKEN',
  'R_GBRAIN_INGEST_TOKEN',
  'R_GBRAIN_MAINTENANCE_TOKEN',
  'GITLAB_WEBHOOK_SIGNING_TOKEN',
]);

/**
 * Same suffix rule the sandbox filter applies, so configuration added later
 * is covered without being listed here. No model-provider credential matches.
 */
function hasSensitiveSuffix(key: string): boolean {
  return (
    /_SECRET$/iu.test(key) ||
    /_PRIVATE_KEY$/iu.test(key) ||
    /PASSWORD$/iu.test(key)
  );
}

/**
 * Removes unused service-level configuration from a helper environment in
 * place. Model-provider credentials (the built-in set plus any declared in
 * `R_MODEL_ENV_KEYS`) and anything the caller passed explicitly are kept.
 */
export function scrubOpenCodeHelperEnv(
  env: NodeJS.ProcessEnv,
  explicitEnv: Partial<Record<string, string | undefined>> = {},
): void {
  const keptKeys = new Set<string>([
    ...DEFAULT_MODEL_PROVIDER_ENV_KEYS,
    ...parseModelProviderEnvKeys(env.R_MODEL_ENV_KEYS),
    ...Object.entries(explicitEnv).flatMap(([key, value]) =>
      value === undefined ? [] : [key],
    ),
  ]);

  for (const key of Object.keys(env)) {
    if (keptKeys.has(key)) {
      continue;
    }

    if (HELPER_BLOCKED_ENV_KEYS.has(key) || hasSensitiveSuffix(key)) {
      delete env[key];
    }
  }
}
