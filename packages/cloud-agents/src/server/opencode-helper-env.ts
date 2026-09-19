import {
  CONTROL_PLANE_ENV_VAR_NAMES,
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
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
 * The names below are service tokens that list does not carry because they
 * are never offered through the environment editor.
 */
const HELPER_ONLY_BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set([
  'R_BRAIN_GATEWAY_TOKEN',
  'R_GBRAIN_ADMIN_TOKEN',
  'R_GBRAIN_AGENT_TOKEN',
  'R_GBRAIN_INGEST_TOKEN',
  'R_GBRAIN_MAINTENANCE_TOKEN',
]);

function isBlockedHelperEnvKey(key: string): boolean {
  return (
    CONTROL_PLANE_ENV_VAR_NAMES.has(key) ||
    HELPER_ONLY_BLOCKED_ENV_KEYS.has(key) ||
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
