import {
  isComputeProvider,
  type ComputeProvider,
} from './compute-providers/compute-provider';
import {
  getSetupComputeProvider,
  isRequiredComputeField,
} from './setup-compute-config';

/** POSIX env var name: letters, digits, underscores; no leading digit. */
const VALID_ENV_VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Launcher-only JSON env var that carries the outer deployment's compute
 * provider configuration into environment workspaces that opted in with
 * `inherit_compute: true`. Every compute credential name is a reserved
 * control-plane name that is stripped before a sandbox sees it, so a nested
 * Roomote instance running inside an environment could never spawn its own
 * sandboxes. This var travels under a non-reserved name and the worker expands
 * it back into the real names for the nested app only.
 */
export const NESTED_COMPUTE_ENV_VAR_NAME = 'R_NESTED_COMPUTE_ENV' as const;

/**
 * Providers that cannot be nested: Local Docker needs the host's Docker
 * socket, which is not reachable from inside a sandbox.
 */
const NON_NESTABLE_COMPUTE_PROVIDERS: ReadonlySet<ComputeProvider> = new Set([
  'docker',
]);

export interface NestedComputeEnvInput {
  provider: ComputeProvider;
  /** Resolved setup-catalog env values for `provider` (process env + saved). */
  resolvedEnvValues: Partial<Record<string, string | undefined>>;
}

/**
 * Builds the env map a nested Roomote instance needs to spawn sandboxes with
 * the outer deployment's provider: `DEFAULT_COMPUTE_PROVIDER` plus every
 * populated setup-catalog field for that provider. Returns null when the
 * provider cannot be nested or a required field is missing, so callers never
 * forward a half-configured provider.
 */
export function buildNestedComputeEnv(
  input: NestedComputeEnvInput,
): Record<string, string> | null {
  if (NON_NESTABLE_COMPUTE_PROVIDERS.has(input.provider)) {
    return null;
  }

  const descriptor = getSetupComputeProvider(input.provider);
  const env: Record<string, string> = {
    DEFAULT_COMPUTE_PROVIDER: input.provider,
  };

  for (const field of descriptor.fields) {
    const value = input.resolvedEnvValues[field.envVarName]?.trim();

    if (value) {
      env[field.envVarName] = value;
    } else if (isRequiredComputeField(field)) {
      return null;
    }
  }

  return env;
}

export function serializeNestedComputeEnv(env: Record<string, string>): string {
  return JSON.stringify(env);
}

/**
 * Parses the launcher-provided JSON. Anything that is not a flat object of
 * valid env var names to strings, or that names a provider Roomote does not
 * know, is ignored rather than expanded into the nested shell.
 */
export function parseNestedComputeEnv(
  raw: string | undefined,
): Record<string, string> | null {
  if (!raw?.trim()) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !VALID_ENV_VAR_NAME.test(name)) {
      return null;
    }

    env[name] = value;
  }

  const provider = env.DEFAULT_COMPUTE_PROVIDER;

  if (!provider || !isComputeProvider(provider)) {
    return null;
  }

  return env;
}
