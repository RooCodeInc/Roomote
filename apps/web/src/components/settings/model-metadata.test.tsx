import { formatMetadataSummary } from './model-metadata';

describe('formatMetadataSummary price', () => {
  it.each([
    [999.99, '$999.99'],
    [1000, '$1,000.00'],
    [1234.56, '$1,234.56'],
    [0, '$0'],
    [0.001, '<$0.01'],
    [0.01, '$0.01'],
    [1.5, '$1.50'],
  ])('formats $%s per million tokens as %s', (perMillion, expected) => {
    const metadata = {
      contextWindow: null,
      inputTypes: null,
      inputPricePerToken: perMillion / 1_000_000,
      outputPricePerToken: perMillion / 1_000_000,
      lastRefreshedAt: null,
    };

    expect(formatMetadataSummary(metadata).price).toBe(
      `${expected} / ${expected}`,
    );
  });
});
