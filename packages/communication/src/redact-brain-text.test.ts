import { describe, it, expect } from 'vitest';
import { redactBrainText, redactBrainTextFragments } from './redact-brain-text';

describe('shared Brain text masking', () => {
  it('preserves ordinary prose instead of applying tool-only authentication heuristics', () => {
    const text = 'Discuss token generation and Basic authentication design.';
    expect(redactBrainText(text) === text).toBe(true);
  });
  it('masks a truncated private block spanning fragments without dropping their identity', () => {
    const material = 'synthetic-private-material';
    const fragments = [
      'before\n-----BEGIN RSA PRIVATE KEY-----',
      `${material}\n${material}`,
    ];
    const result = redactBrainTextFragments(fragments);
    expect(result).toHaveLength(2);
    expect(result.join('\n').includes(material)).toBe(false);
    expect(result[0]?.includes('before')).toBe(true);
  });
  it('uses the shared published formats and encoded-value handling', () => {
    const values = [
      `glpat-${'G1h2'.repeat(6)}`,
      `sk_${'live'}_${'S3t4'.repeat(6)}`,
      `AKIA${'A1B2'.repeat(4)}`,
      `AIza${'C1d2E'.repeat(7)}`,
    ];
    const encoded = [...`ghp_${'F5g6'.repeat(9)}`]
      .map((char) => `%${char.charCodeAt(0).toString(16)}`)
      .join('');
    for (const value of [...values, encoded])
      expect(redactBrainText(`before ${value} after`).includes(value)).toBe(
        false,
      );
  });
});
