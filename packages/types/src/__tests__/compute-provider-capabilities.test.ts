import {
  getComputeProviderCapabilities,
  getComputeProviderCommandOutputSource,
} from '../compute-providers/capabilities';
import {
  sleepCheckManagedComputeProviders,
  snapshotCapableComputeProviders,
  standbyResumeCapableComputeProviders,
} from '../compute-providers/compute-provider';
import { getWorkerComputeProviderLabel } from '../compute-providers/worker-context';
import { resolveConfiguredComputeProviderResources } from '../compute-provider-usage';

describe('compute provider capabilities', () => {
  it('resolves command output storage for every compute provider', () => {
    for (const [provider, source] of [
      ['roomote', 'central'],
      ['modal', 'none'],
      ['docker', 'none'],
      ['daytona', 'provider'],
      ['e2b', 'provider'],
      ['blaxel', 'provider'],
      ['box', 'provider'],
      ['azure', 'provider'],
    ] as const) {
      expect(getComputeProviderCommandOutputSource(provider)).toBe(source);
    }
  });

  it('marks all sandbox providers as supporting Docker projects', () => {
    for (const provider of [
      'docker',
      'modal',
      'daytona',
      'e2b',
      'blaxel',
      'box',
      'roomote',
    ] as const) {
      expect(
        getComputeProviderCapabilities(provider).supportsDockerProjects,
      ).toBe(true);
    }
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
