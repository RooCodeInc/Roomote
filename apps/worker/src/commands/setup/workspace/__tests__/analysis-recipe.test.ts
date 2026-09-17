import { describe, expect, it } from 'vitest';

import {
  R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION,
  R_BIOCONDUCTOR_RECIPE_CATALOG_ID,
  R_BIOCONDUCTOR_RECIPE_IMAGE,
  R_BIOCONDUCTOR_RECIPE_R_VERSION,
} from '@roomote/types';

import { buildRAnalysisRecipeCommands } from '../analysis-recipe';

describe('buildRAnalysisRecipeCommands', () => {
  it('uses the immutable image and persisted lock library', () => {
    const commands = buildRAnalysisRecipeCommands({
      recipePath: '/sandbox/repos/.roomote/recipes/abc',
      recipe: {
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
    });

    expect(commands[0].run).toContain(R_BIOCONDUCTOR_RECIPE_IMAGE);
    expect(commands[1].run).toContain('renv::restore');
    expect(commands[2].run).toContain('requireNamespace');
  });
});
