import { buildBaseWorkerEnv } from './base';
import { buildWorkerContextEnv } from './context';
import type { BuildWorkerEnvOptions } from './types';

export function buildBoxWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  deploymentSlug,
  environmentId,
  machineType,
}: BuildWorkerEnvOptions & {
  deploymentSlug?: string;
  machineType?: string;
}): Record<string, string> {
  return {
    ...buildBaseWorkerEnv({
      authToken,
      sandboxExpiresAtMs,
      extraEnv,
      environmentId,
    }),
    ...buildWorkerContextEnv({
      provider: 'box',
      fingerprint: machineType,
      fingerprintKind: machineType ? 'runtime' : undefined,
      deploymentSlug,
      environmentId,
    }),
    HOME: '/home/user',
  };
}
