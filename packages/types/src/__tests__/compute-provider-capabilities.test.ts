import {
  getComputeProviderCapabilities,
  getComputeProviderCommandOutputSource,
} from '../compute-providers/capabilities';
import {
  sleepCheckManagedComputeProviders,
  snapshotCapableComputeProviders,
  standbyResumeCapableComputeProviders,
  resolveComputeProviderTarget,
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

describe('lazy compute provider fallback', () => {
  it.each(['modal', 'docker', 'blaxel', 'roomote'] as const)(
    'keeps valid %s without evaluating fallback',
    async (provider) => {
      const fallback = vi
        .fn()
        .mockRejectedValue(
          new Error('No configured sandbox provider is available.'),
        );
      expect(await resolveComputeProviderTarget(provider, fallback)).toBe(
        provider,
      );
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 'invalid', 'sandbox'])(
    'evaluates fallback only for missing/invalid %s',
    async (provider) => {
      const fallback = vi.fn().mockResolvedValue('modal');
      expect(await resolveComputeProviderTarget(provider, fallback)).toBe(
        'modal',
      );
      expect(fallback).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, null, 'invalid'])(
    'preserves a rejected real default for %s',
    async (provider) => {
      const error = new Error('No configured sandbox provider is available.');
      const fallback = vi.fn().mockRejectedValue(error);
      await expect(
        resolveComputeProviderTarget(provider, fallback),
      ).rejects.toBe(error);
    },
  );
});
