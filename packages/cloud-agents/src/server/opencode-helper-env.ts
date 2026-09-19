import {
  CONTROL_PLANE_ENV_VAR_NAMES,
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME,
  SOURCE_CONTROL_ACCESS_TOKEN_ENV_VARS,
  parseModelProviderEnvKeys,
} from '@roomote/types';

/**
 * Service-level configuration a non-task OpenCode helper process does not use.
 *
 * The helper is a model client. Roomote's native tools call back to the
 * launching service over the tool bridge, so the helper itself only needs
 * model-provider credentials and the variables passed to it explicitly.
 *
 * The shared control-plane list is the source of truth, the same one that
 * keeps these values out of task sandboxes, so the two cannot drift apart.
 */

/**
 * Configuration the shared list does not carry because it is never offered
 * through the environment editor, excluded by prefix so `_FILE` path variants
 * and names added later are covered too:
 * - Brain service settings: Brain calls go through the launching service.
 * - Platform-generated service values some hosts inject into every container.
 */
const HELPER_BLOCKED_ENV_KEY_PREFIXES = [
  'R_BRAIN_',
  'R_GBRAIN_',
  'GBRAIN_',
  'SERVICE_PASSWORD_',
  'SERVICE_BASE64_',
] as const;

/**
 * Names the shared list leaves out on purpose because task sandboxes need
 * them, but helpers do not: the launcher-only workspace key, and the
 * source-control access tokens (helpers reach source control through the
 * tool bridge, not with a token of their own).
 */
const HELPER_BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set([
  SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME,
  ...SOURCE_CONTROL_ACCESS_TOKEN_ENV_VARS,
]);

function isBlockedHelperEnvKey(key: string): boolean {
  return (
    CONTROL_PLANE_ENV_VAR_NAMES.has(key) ||
    HELPER_BLOCKED_ENV_KEYS.has(key) ||
    HELPER_BLOCKED_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    hasSensitiveSuffix(key)
  );
}

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

    if (isBlockedHelperEnvKey(key)) {
      delete env[key];
    }
  }
}
