import type { WorkerRuntimePaths } from '@roomote/types';

export const DEFAULT_OPENCODE_CLI_VERSION = '1.17.8';

export const ROOMOTE_OPENCODE_CLI_VERSION_ENV = 'ROOMOTE_OPENCODE_CLI_VERSION';
export const ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV =
  'ROOMOTE_BAKED_OPENCODE_CLI_VERSION';

export const NODE_PTY_PACKAGE_SPEC = 'node-pty';

export function resolveExpectedOpenCodeCliVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const overrideVersion = env[ROOMOTE_OPENCODE_CLI_VERSION_ENV]?.trim();
  const bakedVersion = env[ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV]?.trim();
  return overrideVersion || bakedVersion || DEFAULT_OPENCODE_CLI_VERSION;
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
