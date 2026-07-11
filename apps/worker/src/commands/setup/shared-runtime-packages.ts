import type { WorkerRuntimePaths } from '@roomote/types';

export const DEFAULT_OPENCODE_CLI_VERSION = '1.17.8';
export const DEFAULT_ZERO_CLI_VERSION = '1.21.0';

export const ROOMOTE_OPENCODE_CLI_VERSION_ENV = 'ROOMOTE_OPENCODE_CLI_VERSION';
export const ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV =
  'ROOMOTE_BAKED_OPENCODE_CLI_VERSION';
export const ROOMOTE_ZERO_CLI_VERSION_ENV = 'ROOMOTE_ZERO_CLI_VERSION';
export const ROOMOTE_BAKED_ZERO_CLI_VERSION_ENV =
  'ROOMOTE_BAKED_ZERO_CLI_VERSION';

export const NODE_PTY_PACKAGE_SPEC = 'node-pty';
export const ZERO_CLI_PACKAGE_NAME = '@zeroxyz/cli';

export function resolveExpectedOpenCodeCliVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const overrideVersion = env[ROOMOTE_OPENCODE_CLI_VERSION_ENV]?.trim();
  const bakedVersion = env[ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV]?.trim();
  return overrideVersion || bakedVersion || DEFAULT_OPENCODE_CLI_VERSION;
}

export function resolveExpectedZeroCliVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const overrideVersion = env[ROOMOTE_ZERO_CLI_VERSION_ENV]?.trim();
  const bakedVersion = env[ROOMOTE_BAKED_ZERO_CLI_VERSION_ENV]?.trim();
  return overrideVersion || bakedVersion || DEFAULT_ZERO_CLI_VERSION;
}

export function usesSharedSandboxRuntimePackages(
  runtimePaths: WorkerRuntimePaths,
): boolean {
  return runtimePaths.runtime !== 'local';
}

export function getSharedSandboxRuntimePackageSpecs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    `opencode-ai@${resolveExpectedOpenCodeCliVersion(env)}`,
    NODE_PTY_PACKAGE_SPEC,
  ];
}

export function getZeroCliPackageSpec(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${ZERO_CLI_PACKAGE_NAME}@${resolveExpectedZeroCliVersion(env)}`;
}

/**
 * The Zero CLI must install into its own npm prefix: `npm install --no-save`
 * reifies the prefix's node_modules down to just the requested package, so
 * sharing the sandbox root would delete opencode-ai/node-pty (and vice versa).
 */
export function resolveZeroCliInstallRoot(
  runtimePaths: WorkerRuntimePaths,
): string {
  return `${runtimePaths.sandboxRootDir}/zero-cli`;
}
