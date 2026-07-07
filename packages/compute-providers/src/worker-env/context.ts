import {
  type ComputeProvider,
  type WorkerComputeProviderFingerprintKind,
  WORKER_CONTEXT_ENV_VARS,
  getWorkerComputeProviderLabel,
} from '@roomote/types';

export function buildWorkerContextEnv({
  provider,
  fingerprint,
  fingerprintKind,
  deploymentSlug,
  environmentId,
}: {
  provider: ComputeProvider;
  fingerprint?: string;
  fingerprintKind?: WorkerComputeProviderFingerprintKind;
  deploymentSlug?: string;
  environmentId?: string;
}): Record<string, string> {
  return {
    COMPUTE_PROVIDER: provider,
    [WORKER_CONTEXT_ENV_VARS.computeProvider]:
      getWorkerComputeProviderLabel(provider),
    ...(fingerprint && {
      [WORKER_CONTEXT_ENV_VARS.computeProviderFingerprint]: fingerprint,
    }),
    ...(fingerprintKind && {
      [WORKER_CONTEXT_ENV_VARS.computeProviderFingerprintKind]: fingerprintKind,
    }),
    ...(deploymentSlug && {
      [WORKER_CONTEXT_ENV_VARS.deploymentSlug]: deploymentSlug,
    }),
    ...(environmentId && {
      [WORKER_CONTEXT_ENV_VARS.environmentId]: environmentId,
    }),
  };
}
