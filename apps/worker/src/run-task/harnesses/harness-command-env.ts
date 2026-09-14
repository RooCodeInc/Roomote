import { getSourceControlTokenEnvVars } from '@roomote/types';
import { isManagedSessionProxyEnv } from '../../env/session-proxy-file';

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
  if (commandEnv.ROOMOTE_SESSION_PROXY_ENV_FILE) {
    for (const name of Object.keys(commandEnv))
      if (isManagedSessionProxyEnv(name)) delete commandEnv[name];
  }

  return commandEnv;
}
