import { COMMS_PROVIDER_ENV_VAR_NAMES } from './setup-auth-config';
import { COMPUTE_PROVIDER_ENV_VAR_NAMES } from './setup-compute-config';
import { SETUP_SOURCE_CONTROL_PROVIDER_CATALOG } from './setup-source-control-config';
import { OPENCODE_AUTH_CONTENT_ENV_VAR_NAME } from './chatgpt-subscription';
import { DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES } from './model-provider-config';

/**
 * Per-repo source-control access tokens. A task legitimately receives the
 * matching provider's token so it can reach its own repository (see
 * `redactSourceControlProviderEnvVars`), so these are NOT control-plane names.
 */
const SOURCE_CONTROL_ACCESS_TOKEN_ENV_VARS: ReadonlySet<string> = new Set([
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GITEA_TOKEN',
  'ADO_TOKEN',
]);

/**
 * Source-control app + webhook secrets, derived from the `secret` fields of the
 * setup catalog (minus the per-repo access tokens above) so this stays in sync
 * as providers/fields change.
 */
export const SOURCE_CONTROL_SECRET_ENV_VAR_NAMES: ReadonlySet<string> = new Set(
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.flatMap((provider) =>
    provider.fields
      .filter((field) => field.secret)
      .flatMap((field) => [
        field.envVarName,
        ...(field.acceptedEnvVarNames ?? []),
      ]),
  ).filter((name) => !SOURCE_CONTROL_ACCESS_TOKEN_ENV_VARS.has(name)),
);

/**
 * Bot / messaging integration secrets that are not covered by a shared setup
 * catalog (Telegram, Discord, Microsoft Teams bot, Linear).
 */
export const INTEGRATION_BOT_SECRET_ENV_VAR_NAMES: ReadonlySet<string> =
  new Set([
    'R_TELEGRAM_BOT_TOKEN',
    'R_TELEGRAM_WEBHOOK_SECRET',
    'R_DISCORD_BOT_TOKEN',
    'R_DISCORD_GATEWAY_SECRET',
    'R_TEAMS_BOT_APP_ID',
    'R_TEAMS_BOT_APP_PASSWORD',
    'R_TEAMS_BOT_TENANT_ID',
    'R_TEAMS_BOT_TOKEN_ENDPOINT',
    'R_TEAMS_BOT_OAUTH_SCOPE',
    'R_LINEAR_CLIENT_ID',
    'R_LINEAR_CLIENT_SECRET',
    'R_LINEAR_WEBHOOK_SECRET',
  ]);

/**
 * Non-secret provider identifiers (app ids, client ids). Not sensitive, but a
 * task never needs the deployment's provider identity, so they are reserved
 * from the generic editor and stripped from the sandbox for defense-in-depth.
 * The setup catalogs mark these fields `secret: false`, so they are listed here
 * explicitly rather than derived.
 */
export const PROVIDER_IDENTIFIER_ENV_VAR_NAMES: ReadonlySet<string> = new Set([
  'R_GITHUB_APP_ID',
  'R_GITHUB_CLIENT_ID',
  'GITLAB_CLIENT_ID',
  'GITEA_CLIENT_ID',
  'SLACK_APP_ID',
  'ADO_CLIENT_ID',
  'ADO_TENANT_ID',
  'ADO_AUTH_MODE',
  'ADO_LINKED_ACCOUNT_ID',
]);

/**
 * Instance / infrastructure secrets managed through the deployment environment,
 * never through the generic environment-variables editor: the at-rest
 * encryption and signing keys, the auth signing keypairs, the ops dashboard
 * password, the setup token, and the datastore/object-storage connection
 * credentials.
 */
export const INSTANCE_SECRET_ENV_VAR_NAMES: ReadonlySet<string> = new Set([
  'ENCRYPTION_KEY',
  'BETTER_AUTH_SECRET',
  'ARTIFACT_SIGNING_KEY',
  'ARTIFACT_SIGNING_KEY_PREVIOUS',
  'DASHBOARD_PASSWORD',
  'SETUP_TOKEN',
  'ROOMOTE_CLOUD_ACCESS_VERIFICATION_SECRET',
  'JOB_AUTH_PRIVATE_KEY',
  'JOB_AUTH_PUBLIC_KEY',
  'PREVIEW_AUTH_PRIVATE_KEY',
  'PREVIEW_AUTH_PUBLIC_KEY',
  'SANDBOX_OIDC_PRIVATE_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  // Operator-owned license key; never inject into agent sandboxes.
  'R_LICENSE_KEY',
]);

/**
 * Declarative environment provisioning inputs, managed through the deployment
 * environment. Not secrets per se, but they are control-plane configuration
 * (the inline YAML may carry per-environment env values) and a task never
 * needs them, so they are reserved from the generic editor and stripped from
 * the sandbox.
 */
const DECLARATIVE_ENVIRONMENT_ENV_VAR_NAMES: ReadonlySet<string> = new Set([
  'ROOMOTE_ENVIRONMENTS_DIR',
  'ROOMOTE_ENVIRONMENTS_YAML',
]);

/**
 * Canonical set of control-plane / provider / instance env var names that are
 * never generic user task environment. It is the single source of truth for two
 * consumers that must not drift apart:
 *
 * - the environment-variables editor reserves these from operators and hides
 *   them from the generic list (they are configured through their dedicated
 *   settings pages or the deployment environment), and
 * - the job env-injection denylist strips them from the agent sandbox.
 *
 * Model-provider API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) are NOT
 * included — the agent harness needs them — except credentials for disabled
 * providers. Per-repo source-control access tokens are also excluded so a task
 * can still reach its own repository.
 */
export const CONTROL_PLANE_ENV_VAR_NAMES: ReadonlySet<string> = new Set<string>(
  [
    ...COMPUTE_PROVIDER_ENV_VAR_NAMES,
    ...COMMS_PROVIDER_ENV_VAR_NAMES,
    ...SOURCE_CONTROL_SECRET_ENV_VAR_NAMES,
    ...INTEGRATION_BOT_SECRET_ENV_VAR_NAMES,
    ...PROVIDER_IDENTIFIER_ENV_VAR_NAMES,
    ...INSTANCE_SECRET_ENV_VAR_NAMES,
    ...DECLARATIVE_ENVIRONMENT_ENV_VAR_NAMES,
    ...DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
  ],
);

/**
 * Env var names Roomote manages itself (not through the generic
 * environment-variables editor) but that the agent harness legitimately
 * needs, so they are intentionally NOT in `CONTROL_PLANE_ENV_VAR_NAMES` (the
 * job env-injection denylist strips control-plane names from the sandbox).
 *
 * Currently this covers `OPENCODE_AUTH_CONTENT`, the JSON blob Roomote
 * injects to authenticate ChatGPT subscription requests inside the opencode
 * harness. Operators must not set it by hand because Roomote refreshes and
 * rewrites it on every task launch.
 */
export const ROOMOTE_MANAGED_ENV_VAR_NAMES: ReadonlySet<string> =
  new Set<string>([OPENCODE_AUTH_CONTENT_ENV_VAR_NAME]);
