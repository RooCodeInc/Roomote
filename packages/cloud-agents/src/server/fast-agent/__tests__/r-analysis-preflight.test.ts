import { describe, expect, it } from 'vitest';

import {
  inspectRAnalysisScript,
  parseRAttachmentText,
} from '../r-analysis-preflight';

describe('inspectRAnalysisScript', () => {
  it('extracts direct package calls and namespaces', () => {
    expect(
      inspectRAnalysisScript(`
        library(DESeq2)
        require("airway")
        ggplot2::ggplot()
        library(ggplot2, quietly = TRUE)
        library(stats)
      `),
    ).toEqual({
      packages: ['airway', 'DESeq2', 'ggplot2'],
      unresolvedPackageExpressions: [],
    });
  });

  it('parses R attachments in linear time without a header regex', () => {
    const source = 'library(DESeq2)';
    expect(parseRAttachmentText(`Attachment: analysis.R\n${source}`)).toEqual({
      filename: 'analysis.R',
      source,
    });
    expect(
      parseRAttachmentText(`Attachment:${'\t'.repeat(80_000)}`),
    ).toBeNull();
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
