import {
  isComputeProvider,
  type ComputeProvider,
} from './compute-providers/compute-provider';
import {
  getSetupComputeProvider,
  isRequiredComputeField,
} from './setup-compute-config';
import { SETUP_SOURCE_CONTROL_PROVIDER_CATALOG } from './setup-source-control-config';

/**
 * Launcher-only JSON env var that carries selected deployment configuration
 * into environment workspaces that opted in with `inherit_compute` and/or
 * `inherit_source_control`. Compute credentials and source-control app
 * secrets are reserved control-plane names that are stripped before a sandbox
 * sees them, so a nested Roomote instance running inside an environment could
 * never spawn its own sandboxes or reach its repositories. The forwarded map
 * travels under this single non-reserved name and the worker expands it back
 * into the real names for the nested app only.
 */
export const NESTED_DEPLOYMENT_ENV_VAR_NAME =
  'R_NESTED_DEPLOYMENT_ENV' as const;

/** POSIX env var name: letters, digits, underscores; no leading digit. */
const VALID_ENV_VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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

/**
 * Every setup-catalog env var name across all source-control providers; the
 * launcher resolves these (process env first, then the encrypted deployment
 * env) before building the nested source-control map.
 */
export const NESTED_SOURCE_CONTROL_ENV_VAR_NAMES: readonly string[] =
  SETUP_SOURCE_CONTROL_PROVIDER_CATALOG.flatMap((descriptor) =>
    descriptor.fields.map((field) => field.envVarName),
  );

export interface NestedSourceControlEnvInput {
  /** Resolved values for NESTED_SOURCE_CONTROL_ENV_VAR_NAMES. */
  resolvedEnvValues: Partial<Record<string, string | undefined>>;
}

/**
 * Builds the env map a nested Roomote instance needs to talk to the outer
 * deployment's source-control providers: every populated setup-catalog field
 * of each provider whose required fields are all present. Providers that are
 * only partially configured are skipped rather than forwarded half-done.
 * Returns null when no provider is fully configured.
 */
export function buildNestedSourceControlEnv(
  input: NestedSourceControlEnvInput,
): Record<string, string> | null {
  const env: Record<string, string> = {};

  for (const descriptor of SETUP_SOURCE_CONTROL_PROVIDER_CATALOG) {
    const providerEnv: Record<string, string> = {};
    let complete = true;

    for (const field of descriptor.fields) {
      const value = input.resolvedEnvValues[field.envVarName]?.trim();

      if (value) {
        providerEnv[field.envVarName] = value;
      } else if (field.required !== false) {
        complete = false;
        break;
      }
    }

    if (complete) {
      Object.assign(env, providerEnv);
    }
  }

  return Object.keys(env).length > 0 ? env : null;
}

/** Merges forwarded parts, ignoring the ones that resolved to nothing. */
export function mergeNestedDeploymentEnv(
  ...parts: Array<Record<string, string> | null | undefined>
): Record<string, string> | null {
  const env: Record<string, string> = {};

  for (const part of parts) {
    if (part) {
      Object.assign(env, part);
    }
  }

  return Object.keys(env).length > 0 ? env : null;
}

export function serializeNestedDeploymentEnv(
  env: Record<string, string>,
): string {
  return JSON.stringify(env);
}

/**
 * Parses the launcher-provided JSON. Anything that is not a non-empty flat
 * object of valid env var names to strings, or that names a compute provider
 * Roomote does not know, is ignored rather than expanded into the nested
 * shell.
 */
export function parseNestedDeploymentEnv(
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

  if (Object.keys(env).length === 0) {
    return null;
  }

  const provider = env.DEFAULT_COMPUTE_PROVIDER;

  if (provider !== undefined && !isComputeProvider(provider)) {
    return null;
  }

  return env;
}
