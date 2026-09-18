import { buildBaseWorkerEnv } from './base';
import { buildWorkerContextEnv } from './context';
import type { BuildWorkerEnvOptions } from './types';

export function buildDockerWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  deploymentSlug,
  environmentId,
  image,
}: BuildWorkerEnvOptions & {
  deploymentSlug?: string;
  image?: string;
}): Record<string, string> {
  return {
    ...buildBaseWorkerEnv({
      authToken,
      sandboxExpiresAtMs,
      extraEnv,
      environmentId,
    }),
    ...buildWorkerContextEnv({
      provider: 'docker',
      fingerprint: image,
      fingerprintKind: image ? 'base-image' : undefined,
      deploymentSlug,
      environmentId,
    }),
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
  };
}
