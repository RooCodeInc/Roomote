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
        library(quietly = TRUE, package = edgeR)
        library(stats)
      `),
    ).toEqual({
      packages: ['airway', 'DESeq2', 'edgeR', 'ggplot2'],
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
      parseRAttachmentText(
        `File attachment: analysis.R (text/x-r-source)\n----- BEGIN ATTACHMENT -----\n${source}\n----- END ATTACHMENT -----`,
      ),
    ).toEqual({
      filename: 'analysis.R',
      source,
    });
    expect(
      parseRAttachmentText(`File attachment: analysis.R.txt\n${source}`),
    ).toBeNull();
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

  it('ignores package-like calls inside quoted strings', () => {
    expect(
      inspectRAnalysisScript(`
        message("library(notAPackage)")
        'require(alsoNotAPackage)'
        library(DESeq2)
      `),
    ).toEqual({
      packages: ['DESeq2'],
      unresolvedPackageExpressions: [],
    });
  });
});
