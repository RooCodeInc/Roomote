import { describe, expect, it } from 'vitest';

import type { EnvironmentConfig, EnvironmentRecipe } from '@roomote/types';

import {
  R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION,
  R_BIOCONDUCTOR_RECIPE_IMAGE,
  R_BIOCONDUCTOR_RECIPE_R_VERSION,
} from '../../environment-recipes/r-bioconductor-adapter';
import {
  isCompatibleRecipeEnvironment,
  isConfiguredEnvironmentId,
} from '../r-analysis-environment';

const resolvedRecipe: EnvironmentRecipe = {
  type: 'r-bioconductor',
  schema_version: 1,
  request: { packages: ['DESeq2', 'airway'] },
  request_fingerprint: 'a'.repeat(64),
  resolution: {
    image: R_BIOCONDUCTOR_RECIPE_IMAGE,
    r_version: R_BIOCONDUCTOR_RECIPE_R_VERSION,
    bioconductor_version: R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION,
    packages: [
      { name: 'DESeq2', version: '1.48.2', repository: 'bioconductor' },
      { name: 'airway', version: '1.28.0', repository: 'bioconductor' },
    ],
    renv_lock: {
      R: { Version: R_BIOCONDUCTOR_RECIPE_R_VERSION },
      Bioconductor: {
        Version: R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION,
      },
      Packages: { DESeq2: {}, airway: {} },
    },
    resolution_fingerprint: 'b'.repeat(64),
  },
};

const config: EnvironmentConfig = {
  name: 'R analysis',
  repositories: [],
  environment_recipe: resolvedRecipe,
};

describe('isCompatibleRecipeEnvironment', () => {
  it('accepts a verified resolved recipe whose direct packages cover the request', () => {
    expect(
      isCompatibleRecipeEnvironment(
        { isVerified: true, config },
        { packages: ['DESeq2'] },
      ),
    ).toBe(true);
  });

  it('rejects unverified or incomplete environments and ignores display names', () => {
    expect(
      isCompatibleRecipeEnvironment(
        { isVerified: false, config },
        { packages: ['DESeq2'] },
      ),
    ).toBe(false);
    expect(
      isCompatibleRecipeEnvironment(
        { isVerified: true, config },
        { packages: ['edgeR'] },
      ),
    ).toBe(false);
  });

  it('rejects unresolved recipes', () => {
    expect(
      isCompatibleRecipeEnvironment(
        {
          isVerified: true,
          config: {
            name: 'R analysis',
            repositories: [],
            environment_recipe: {
              type: 'r-bioconductor',
              schema_version: 1,
              request: { packages: ['DESeq2'] },
              request_fingerprint: 'a'.repeat(64),
            },
          },
        },
        { packages: ['DESeq2'] },
      ),
    ).toBe(false);
  });
});

describe('isConfiguredEnvironmentId', () => {
  const environments = [
    { id: 'env-1', name: 'R analysis', repositoryNames: [] },
  ];

  it('accepts only a real configured environment id', () => {
    expect(isConfiguredEnvironmentId('env-1', environments)).toBe(true);
    expect(
      isConfiguredEnvironmentId('__all_repositories__', environments),
    ).toBe(false);
    expect(isConfiguredEnvironmentId('__no_repositories__', environments)).toBe(
      false,
    );
  });
});
