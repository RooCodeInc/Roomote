import { buildBaseWorkerEnv } from './base';
import { buildWorkerContextEnv } from './context';

import type { BuildWorkerEnvOptions } from './types';

export function buildDaytonaWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  deploymentSlug,
  environmentId,
  snapshotName,
}: BuildWorkerEnvOptions & {
  deploymentSlug?: string;
  environmentId?: string;
  snapshotName: string;
}): Record<string, string> {
  return {
    ...buildBaseWorkerEnv({ authToken, sandboxExpiresAtMs, extraEnv }),
    ...buildWorkerContextEnv({
      provider: 'daytona',
      fingerprint: snapshotName,
      fingerprintKind: 'base-image',
      deploymentSlug,
      environmentId,
    }),
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
  };
}
