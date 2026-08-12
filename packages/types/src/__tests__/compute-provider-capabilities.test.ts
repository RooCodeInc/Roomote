import { getComputeProviderCapabilities } from '../compute-providers/capabilities';
import {
  sleepCheckManagedComputeProviders,
  snapshotCapableComputeProviders,
  standbyResumeCapableComputeProviders,
} from '../compute-providers/compute-provider';
import { getWorkerComputeProviderLabel } from '../compute-providers/worker-context';
import { resolveConfiguredComputeProviderResources } from '../compute-provider-usage';

describe('compute provider capabilities', () => {
  it.each([
    'docker',
    'modal',
    'daytona',
    'e2b',
    'blaxel',
    'box',
    'roomote',
  ] as const)('marks %s as supporting Docker projects', (provider) => {
    expect(
      getComputeProviderCapabilities(provider).supportsDockerProjects,
    ).toBe(true);
  });

  it('classifies Box as standby-resumable with template snapshots', () => {
    expect(getComputeProviderCapabilities('box')).toMatchObject({
      supportsCreateInstance: true,
      supportsDestroyInstance: true,
      supportsCommandExecution: true,
      supportsCommandOutputStreaming: true,
      supportsCommandOutputLookup: true,
      supportsFileWrite: true,
      supportsStandbyResume: true,
      supportsResume: true,
      supportsDockerProjects: true,
      supportsSnapshots: true,
    });
    expect(standbyResumeCapableComputeProviders).toContain('box');
    expect(sleepCheckManagedComputeProviders).toContain('box');
    expect(snapshotCapableComputeProviders).toContain('box');
    expect(getWorkerComputeProviderLabel('box')).toBe('box');
    expect(
      resolveConfiguredComputeProviderResources({ provider: 'box' }),
    ).toEqual({
      configuredVcpus: null,
      configuredCpuCores: null,
      configuredMemoryMiB: null,
    });
  });
});
