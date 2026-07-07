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
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
  };
}
