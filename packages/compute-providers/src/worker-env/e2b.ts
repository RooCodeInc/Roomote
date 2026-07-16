import { buildBaseWorkerEnv } from './base';
import { buildWorkerContextEnv } from './context';

import type { BuildWorkerEnvOptions } from './types';

export function buildE2bWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  inferenceGatewayEnabled,
  deploymentSlug,
  environmentId,
  templateId,
}: BuildWorkerEnvOptions & {
  deploymentSlug?: string;
  environmentId?: string;
  templateId: string;
}): Record<string, string> {
  return {
    ...buildBaseWorkerEnv({
      authToken,
      sandboxExpiresAtMs,
      extraEnv,
      inferenceGatewayEnabled,
    }),
    ...buildWorkerContextEnv({
      provider: 'e2b',
      fingerprint: templateId,
      fingerprintKind: 'base-image',
      deploymentSlug,
      environmentId,
    }),
    // The template snapshots Docker's packaged service, which listens on the
    // standard Unix socket. Keep an explicit override for custom E2B runtimes.
    DOCKER_HOST: extraEnv?.DOCKER_HOST ?? 'unix:///var/run/docker.sock',
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
  };
}
