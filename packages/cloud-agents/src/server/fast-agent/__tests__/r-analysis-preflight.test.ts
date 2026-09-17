import { describe, expect, it } from 'vitest';

import { inspectRAnalysisScript } from '../r-analysis-preflight';

describe('inspectRAnalysisScript', () => {
  it('extracts direct package calls and namespaces', () => {
    expect(
      inspectRAnalysisScript(`
        library(DESeq2)
        require("airway")
        ggplot2::ggplot()
        library(stats)
      `),
    ).toEqual({
      packages: ['airway', 'DESeq2', 'ggplot2'],
      unresolvedPackageExpressions: [],
    });
  });

  it('reports dynamic package expressions without treating comments as code', () => {
    expect(
      inspectRAnalysisScript(`
        pkg <- "DESeq2"
        library(pkg, character.only=TRUE)
        # library(airway)
      `),
    ).toEqual({
      packages: [],
      unresolvedPackageExpressions: ['pkg'],
    });
  });
});
