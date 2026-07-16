import { type ComputeProvider } from './compute-providers';

export const computeProviderUsageLifecycleActions = [
  'running',
  'destroy',
  'snapshot',
] as const;

export type ComputeProviderUsageLifecycleAction =
  (typeof computeProviderUsageLifecycleActions)[number];

export const computeProviderUsageFinalLifecycleActions = [
  'destroy',
  'snapshot',
] as const satisfies readonly ComputeProviderUsageLifecycleAction[];

export const computeProviderUsageMeasurementSources = [
  'provider_report',
  'vercel_sdk_metrics',
  'modal_requested_resources',
  'modal_cgroup_samples',
  'roomote_observation',
] as const;

export type ComputeProviderUsageMeasurementSource =
  (typeof computeProviderUsageMeasurementSources)[number];

export const MODAL_DEFAULT_CPU_CORES = 0.125;
export const MODAL_DEFAULT_MEMORY_MIB = 128;

export interface ComputeProviderConfiguredResources {
  configuredVcpus: number | null;
  configuredCpuCores: number | null;
  configuredMemoryMiB: number | null;
}

function clampNonNegativeInteger(value: number | null | undefined): number {
  const numericValue = Number(value);

  return Number.isFinite(numericValue)
    ? Math.max(0, Math.trunc(numericValue))
    : 0;
}

function clampNonNegativeNumber(value: number | null | undefined): number {
  const numericValue = Number(value);

  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
}

export function resolveConfiguredComputeProviderResources(input: {
  provider: ComputeProvider;
  configuredVcpus?: number | null;
  configuredCpuCores?: number | null;
  configuredMemoryMiB?: number | null;
}): ComputeProviderConfiguredResources {
  switch (input.provider) {
    // Roomote Cloud sandboxes run on Modal, so they share its resource model.
    case 'modal':
    case 'roomote': {
      const configuredCpuCores =
        clampNonNegativeNumber(input.configuredCpuCores) ||
        MODAL_DEFAULT_CPU_CORES;

      const configuredMemoryMiB =
        clampNonNegativeInteger(input.configuredMemoryMiB) ||
        MODAL_DEFAULT_MEMORY_MIB;

      return {
        configuredVcpus: null,
        configuredCpuCores,
        configuredMemoryMiB,
      };
    }
    case 'docker':
    case 'daytona':
    case 'e2b':
    case 'blaxel':
      return {
        configuredVcpus: null,
        configuredCpuCores: null,
        configuredMemoryMiB: null,
      };
    default: {
      const _exhaustive: never = input.provider;
      throw new Error(
        `Unsupported compute provider for resource resolution: ${_exhaustive}`,
      );
    }
  }
}
