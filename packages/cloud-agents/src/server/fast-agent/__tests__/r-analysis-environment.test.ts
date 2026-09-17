import { describe, expect, it } from 'vitest';

import {
  R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION,
  R_BIOCONDUCTOR_RECIPE_CATALOG_ID,
  R_BIOCONDUCTOR_RECIPE_IMAGE,
  R_BIOCONDUCTOR_RECIPE_R_VERSION,
  type EnvironmentConfig,
} from '@roomote/types';

import {
  isCompatibleRAnalysisEnvironment,
  isConfiguredEnvironmentId,
} from '../r-analysis-environment';

const config: EnvironmentConfig = {
  name: 'R analysis',
  repositories: [],
  analysis_recipe: {
    type: 'r-bioconductor',
    schema_version: 1,
    catalog_id: R_BIOCONDUCTOR_RECIPE_CATALOG_ID,
    image: R_BIOCONDUCTOR_RECIPE_IMAGE,
    r_version: R_BIOCONDUCTOR_RECIPE_R_VERSION,
    bioconductor_version: R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION,
    direct_packages: [
      { name: 'DESeq2', source: 'bioconductor' },
      { name: 'airway', source: 'bioconductor' },
    ],
    renv_lock: JSON.stringify({
      R: { Version: R_BIOCONDUCTOR_RECIPE_R_VERSION },
      Bioconductor: {
        Version: R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION,
      },
      Packages: { DESeq2: {}, airway: {} },
    }),
  },
};

describe('isCompatibleRAnalysisEnvironment', () => {
  it('accepts a verified package superset', () => {
    expect(
      isCompatibleRAnalysisEnvironment({ isVerified: true, config }, [
        'DESeq2',
      ]),
    ).toBe(true);
  });

  it('rejects unverified or incomplete environments', () => {
    expect(
      isCompatibleRAnalysisEnvironment({ isVerified: false, config }, [
        'DESeq2',
      ]),
    ).toBe(false);
    expect(
      isCompatibleRAnalysisEnvironment({ isVerified: true, config }, ['edgeR']),
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
