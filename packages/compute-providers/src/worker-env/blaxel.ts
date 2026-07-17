import { buildBaseWorkerEnv } from './base';
import { buildWorkerContextEnv } from './context';
import type { BuildWorkerEnvOptions } from './types';

export function buildBlaxelWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  deploymentSlug,
  environmentId,
  image,
}: BuildWorkerEnvOptions & {
  deploymentSlug?: string;
  environmentId?: string;
  image: string;
}): Record<string, string> {
  return {
    ...buildBaseWorkerEnv({
      authToken,
      sandboxExpiresAtMs,
      extraEnv,
    }),
    ...buildWorkerContextEnv({
      provider: 'blaxel',
      fingerprint: image,
      fingerprintKind: 'base-image',
      deploymentSlug,
      environmentId,
    }),
    // Commands execute as root through Blaxel's sandbox API, but the Roomote
    // image's mise tool configuration belongs to the image's roomote user.
    HOME: '/home/roomote',
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
  };
}
