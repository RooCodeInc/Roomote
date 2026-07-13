import { buildBaseWorkerEnv } from './base';
import { buildWorkerContextEnv } from './context';

import type { BuildWorkerEnvOptions } from './types';

export function buildE2bWorkerEnv({
  authToken,
  sandboxExpiresAtMs,
  extraEnv,
  deploymentSlug,
  environmentId,
  templateId,
}: BuildWorkerEnvOptions & {
  deploymentSlug?: string;
  environmentId?: string;
  templateId: string;
}): Record<string, string> {
  return {
    ...buildBaseWorkerEnv({ authToken, sandboxExpiresAtMs, extraEnv }),
    ...buildWorkerContextEnv({
      provider: 'e2b',
      fingerprint: templateId,
      fingerprintKind: 'base-image',
      deploymentSlug,
      environmentId,
    }),
    // E2B's Docker-enabled sandbox runtime exposes its daemon over this
    // loopback endpoint rather than the default Unix socket. Keep an explicit
    // caller override for self-hosted/custom E2B environments.
    DOCKER_HOST: extraEnv?.DOCKER_HOST ?? 'tcp://127.0.0.1:2375',
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
  };
}
