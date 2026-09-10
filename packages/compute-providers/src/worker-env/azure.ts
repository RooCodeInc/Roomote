import { buildBaseWorkerEnv } from './base';
import { buildWorkerContextEnv } from './context';

import type { BuildWorkerEnvOptions } from './types';

export function buildAzureWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  deploymentSlug,
  environmentId,
  diskImage,
}: BuildWorkerEnvOptions & {
  deploymentSlug?: string;
  diskImage: string;
}): Record<string, string> {
  return {
    ...buildBaseWorkerEnv({
      authToken,
      sandboxExpiresAtMs,
      extraEnv,
      environmentId,
    }),
    ...buildWorkerContextEnv({
      provider: 'azure',
      fingerprint: diskImage,
      fingerprintKind: 'base-image',
      deploymentSlug,
      environmentId,
    }),
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
  };
}
