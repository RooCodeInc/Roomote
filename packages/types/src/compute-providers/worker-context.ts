import type { ComputeProvider } from './compute-provider';

export const WORKER_CONTEXT_ENV_VARS = {
  deploymentSlug: 'ROOMOTE_WORKER_DEPLOYMENT_SLUG',
  environmentId: 'ROOMOTE_WORKER_ENVIRONMENT_ID',
  computeProvider: 'ROOMOTE_WORKER_COMPUTE_PROVIDER',
  computeProviderFingerprint: 'ROOMOTE_WORKER_COMPUTE_FINGERPRINT',
  computeProviderFingerprintKind: 'ROOMOTE_WORKER_COMPUTE_FINGERPRINT_KIND',
} as const;

export type WorkerComputeProviderLabel =
  | 'docker'
  | 'modal'
  | 'daytona'
  | 'e2b'
  | 'blaxel';

export type WorkerComputeProviderFingerprintKind = 'base-image' | 'runtime';

export function getWorkerComputeProviderLabel(
  provider: ComputeProvider,
): WorkerComputeProviderLabel {
  switch (provider) {
    case 'modal':
    case 'docker':
    case 'daytona':
    case 'e2b':
    case 'blaxel':
      return provider;
    // Roomote Cloud workers run inside Modal sandboxes, so worker-side
    // runtime handling (cgroup layout, usage polling) must match Modal.
    case 'roomote':
      return 'modal';
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported compute provider: ${_exhaustive}`);
    }
  }
}
