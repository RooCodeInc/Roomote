import { getSourceControlTokenEnvVars } from '@roomote/types';

/**
 * Long-lived harness processes and runtime sessions should not inherit a
 * fixed source-control token value. Keep BASH_ENV so each bash command
 * re-sources the worker-managed env file and picks up the latest token file
 * contents.
 */
export function buildHarnessCommandEnv(
  runtimeEnv: Record<string, string>,
): Record<string, string> {
  const commandEnv = { ...runtimeEnv };

  for (const envVar of getSourceControlTokenEnvVars()) {
    delete commandEnv[envVar];
  }

  return commandEnv;
}
