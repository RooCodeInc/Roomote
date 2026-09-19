import { describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from '@roomote/types';

import { rBioconductorControlAdapter } from './r-bioconductor-adapter';
import {
  getRecipeControlAdapter,
  listRecipeControlAdapterTypes,
  requireRecipeControlAdapter,
} from './registry';

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

describe('recipe control registry', () => {
  it('registers only the r-bioconductor adapter', () => {
    expect(listRecipeControlAdapterTypes()).toEqual(['r-bioconductor']);
    expect(getRecipeControlAdapter('r-bioconductor')).toBe(
      rBioconductorControlAdapter,
    );
    expect(requireRecipeControlAdapter('r-bioconductor')).toBe(
      rBioconductorControlAdapter,
    );
  });
});

describe('rBioconductorControlAdapter', () => {
  it('normalizes, dedupes, and sorts requests and computes a stable request fingerprint', () => {
    const normalized = rBioconductorControlAdapter.normalizeRequest({
      packages: [' DESeq2 ', 'airway', 'DESeq2', 'edgeR'],
    });
    expect(normalized.packages).toEqual(['airway', 'DESeq2', 'edgeR']);
    const left =
      rBioconductorControlAdapter.computeRequestFingerprint(normalized);
    const right = rBioconductorControlAdapter.computeRequestFingerprint({
      packages: ['DESeq2', 'airway', 'edgeR'],
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  it('describes setup time/impact deterministically', () => {
    const descriptor = rBioconductorControlAdapter.describeSetupRequest({
      packages: ['DESeq2', 'airway'],
    });
    expect(descriptor.setupTimeBoundMinutes).toBeGreaterThan(0);
    expect(descriptor.persistenceImpact).toContain('environment');
    expect(descriptor.impactSummary).toContain('2');
  });

  it('accepts a complete resolved recipe and rejects floating runtime', () => {
    expect(
      rBioconductorControlAdapter.validateResolvedRecipe(resolvedRecipe),
    ).toEqual({ valid: true });
    const floating = {
      ...resolvedRecipe,
      resolution: {
        ...resolvedRecipe.resolution!,
        image: 'bioconductor/bioconductor_docker:RELEASE_3_21',
      },
    };
    const result = rBioconductorControlAdapter.validateResolvedRecipe(floating);
    expect(result.valid).toBe(false);
  });

  it('computes a stable resolution fingerprint over the canonical resolution', () => {
    const resolution = resolvedRecipe.resolution!;
    const fingerprint =
      rBioconductorControlAdapter.computeResolutionFingerprint(resolution);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      rBioconductorControlAdapter.computeResolutionFingerprint({
        ...resolution,
        renv_lock: {
          Bioconductor: { Version: '3.21' },
          R: { Version: '4.5.2' },
          Packages: { DESeq2: {}, airway: {} },
        },
      }),
    ).toBe(fingerprint);
  });

  it('only adds the DESeq2/airway smoke to verification instructions when both are requested', () => {
    const generic = rBioconductorControlAdapter.buildVerificationInstructions({
      ...resolvedRecipe,
      request: { packages: ['tximeta'] },
    } as EnvironmentRecipe);
    expect(generic).not.toContain('DESeq2 smoke');
    const smoke =
      rBioconductorControlAdapter.buildVerificationInstructions(resolvedRecipe);
    expect(smoke).toContain('DESeq2 smoke analysis');
  });
});
