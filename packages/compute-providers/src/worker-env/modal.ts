import { buildBaseWorkerEnv } from './base';
import { buildWorkerContextEnv } from './context';

import type { BuildWorkerEnvOptions } from './types';

export function buildModalWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  deploymentSlug,
  environmentId,
  baseImageRef,
}: BuildWorkerEnvOptions & {
  deploymentSlug?: string;
  baseImageRef: string;
}): Record<string, string> {
  return {
    ...buildBaseWorkerEnv({
      authToken,
      sandboxExpiresAtMs,
      extraEnv,
      environmentId,
    }),
    ...buildWorkerContextEnv({
      provider: 'modal',
      fingerprint: baseImageRef,
      fingerprintKind: 'base-image',
      deploymentSlug,
      environmentId,
    }),
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
  };
}
