import { JUDGE_DEFAULT_THRESHOLD, judgePolicySchema } from '../judge-policy';

describe('judgePolicySchema', () => {
  it('accepts the minimal policy and uses the platform default threshold', () => {
    const policy = judgePolicySchema.parse({
      criteria: [{ rule: 'Keep UI copy concise.' }],
    });

    expect(policy.criteria[0]?.rule).toBe('Keep UI copy concise.');
    expect(policy.criteria[0]?.threshold ?? JUDGE_DEFAULT_THRESHOLD).toBe(0.85);
  });

  it('accepts repository-relative globs and custom thresholds', () => {
    expect(
      judgePolicySchema.parse({
        criteria: [
          {
            rule: 'Use sentence case.',
            files: ['apps/web/**/*.tsx', 'docs/*.mdx'],
            threshold: 0.8,
          },
        ],
      }),
    ).toEqual({
      criteria: [
        {
          rule: 'Use sentence case.',
          files: ['apps/web/**/*.tsx', 'docs/*.mdx'],
          threshold: 0.8,
        },
      ],
    });
  });

  it.each([
    { criteria: [] },
    { criteria: [{ rule: '' }] },
    { criteria: [{ rule: 'Rule', threshold: 1.1 }] },
    { criteria: [{ rule: 'Rule', files: ['/absolute/*.tsx'] }] },
    { criteria: [{ rule: 'Rule', files: ['../outside/*.tsx'] }] },
    { criteria: [{ rule: 'Rule', severity: 'high' }] },
    { criteria: [{ rule: 'Rule' }], threshold: 0.5 },
  ])('rejects malformed policy %o', (policy) => {
    expect(() => judgePolicySchema.parse(policy)).toThrow();
  });
});
