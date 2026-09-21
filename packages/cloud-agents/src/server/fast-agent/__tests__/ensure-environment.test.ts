import { describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from '@roomote/types';

import { rBioconductorControlAdapter } from '../../environment-recipes/r-bioconductor-adapter';
import {
  type EnsureEnvironmentAvailableEnvironment,
  launchEnvironmentRecipeVerification,
  previewEnsureEnvironment,
} from '../ensure-environment';

const resolvedRecipe: EnvironmentRecipe = {
  type: 'r-bioconductor',
  schema_version: 1,
  request: { packages: ['DESeq2', 'airway'] },
  request_fingerprint: 'a'.repeat(64),
  resolution: {
    image:
      'bioconductor/bioconductor_docker@sha256:41ed449aa2181f330cdc8d0499a11a7435b04827ff926dc141584a34f65a12cb',
    r_version: '4.5.2',
    bioconductor_version: '3.21',
    packages: [
      { name: 'DESeq2', version: '1.48.2', repository: 'bioconductor' },
      { name: 'airway', version: '1.28.0', repository: 'bioconductor' },
    ],
    renv_lock: {
      R: { Version: '4.5.2' },
      Bioconductor: { Version: '3.21' },
      Packages: { DESeq2: {}, airway: {} },
    },
    resolution_fingerprint: 'b'.repeat(64),
  },
};

const verifiedEnvironment: EnsureEnvironmentAvailableEnvironment = {
  id: 'env-verified',
  name: 'R + Bioconductor — Airway RNA-seq',
  isVerified: true,
  config: {
    name: 'R analysis',
    repositories: [],
    environment_recipe: resolvedRecipe,
  },
};

describe('previewEnsureEnvironment', () => {
  it('reuses a verified compatible environment regardless of display name', () => {
    const result = previewEnsureEnvironment({
      adapter: rBioconductorControlAdapter,
      request: { packages: ['DESeq2'] },
      name: 'Anything names it',
      purpose: 'Airway RNA-seq',
      environments: [verifiedEnvironment],
    });

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.environmentId).toBe('env-verified');
    }
  });

  it('returns name_unavailable when the selected name belongs to an incompatible environment', () => {
    const incompatible: EnsureEnvironmentAvailableEnvironment = {
      id: 'env-other',
      name: 'R + Bioconductor — Airway RNA-seq',
      isVerified: false,
      config: { name: 'Other', repositories: [] },
    };

    const result = previewEnsureEnvironment({
      adapter: rBioconductorControlAdapter,
      request: { packages: ['DESeq2'] },
      name: 'R + Bioconductor — Airway RNA-seq',
      purpose: 'Airway RNA-seq',
      environments: [incompatible],
    });

    expect(result.status).toBe('name_unavailable');
  });

  it('returns a bound proposal for an admin when nothing matches', () => {
    const result = previewEnsureEnvironment({
      adapter: rBioconductorControlAdapter,
      request: { packages: ['DESeq2', 'airway'] },
      name: 'Bioconductor — Airway RNA-seq',
      purpose: 'Airway RNA-seq',
      environments: [],
    });

    expect(result.status).toBe('proposal');
    if (result.status === 'proposal') {
      expect(result.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(result.setupTimeBoundMinutes).toBeGreaterThan(0);
      expect(result.persistenceImpact).toBeTruthy();
      expect(result.impactSummary).toBeTruthy();
    }
  });

  it('reports an existing candidate state with a retry proposal fingerprint', () => {
    const candidate: EnsureEnvironmentAvailableEnvironment = {
      id: 'env-candidate',
      name: 'R + Bioconductor — Airway RNA-seq',
      isVerified: false,
      verificationError: 'Resolution failed',
      config: {
        name: 'R analysis',
        repositories: [],
        environment_recipe: {
          type: 'r-bioconductor',
          schema_version: 1,
          request: rBioconductorControlAdapter.normalizeRequest({
            packages: ['DESeq2'],
          }),
          request_fingerprint:
            rBioconductorControlAdapter.computeRequestFingerprint(
              rBioconductorControlAdapter.normalizeRequest({
                packages: ['DESeq2'],
              }),
            ),
        },
      },
    };

    const result = previewEnsureEnvironment({
      adapter: rBioconductorControlAdapter,
      request: { packages: ['DESeq2'] },
      name: 'R + Bioconductor — Airway RNA-seq',
      purpose: 'Airway RNA-seq',
      environments: [candidate],
    });

    expect(result.status).toBe('existing');
    if (result.status === 'existing') {
      expect(result.state).toBe('failed');
      expect(result.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('launchEnvironmentRecipeVerification', () => {
  it('reuses an active verification attempt without launching another task', async () => {
    const launch = vi.fn();

    const result = await launchEnvironmentRecipeVerification({
      environmentId: 'environment-1',
      withLock: async (_environmentId, mutation) => mutation('locked'),
      findActiveTaskId: async () => 'active-task',
      launch,
    });

    expect(result).toEqual({
      success: true,
      taskId: 'active-task',
      alreadyActive: true,
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches a fresh attempt after the previous attempt is terminal', async () => {
    const launch = vi.fn(async () => ({
      success: true as const,
      taskId: 'replacement-task',
    }));

    const result = await launchEnvironmentRecipeVerification({
      environmentId: 'environment-1',
      withLock: async (_environmentId, mutation) => mutation('locked'),
      findActiveTaskId: async () => null,
      launch,
    });

    expect(result).toEqual({
      success: true,
      taskId: 'replacement-task',
    });
    expect(launch).toHaveBeenCalledOnce();
  });
});
