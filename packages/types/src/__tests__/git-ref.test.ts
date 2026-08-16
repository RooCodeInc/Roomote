import { describe, expect, it } from 'vitest';

import { gitBranchNameSchema } from '../git-ref';

describe('gitBranchNameSchema', () => {
  it.each([
    ['main', true],
    ['develop', true],
    ['feature/foo', true],
    ['feature/foo-bar_baz.1', true],
    ['release/1.2.3', true],
    ['0-numeric-start', true],
    ['', false],
    ['-leading-dash', false],
    ['/leading-slash', false],
    ['.leading-dot', false],
    ['feature/../escape', false],
    ['feature//double', false],
    ['feature@{0}', false],
    ['feature branch', false],
    ['feature;rm -rf /', false],
    ['feature$(whoami)', false],
    ['feature`whoami`', false],
    ['feature|tee', false],
    ['feature&background', false],
  ])('gitBranchNameSchema accepts %j === %s', (branch, expected) => {
    expect(gitBranchNameSchema.safeParse(branch).success).toBe(expected);
  });

  it('trims surrounding whitespace', () => {
    expect(gitBranchNameSchema.parse('  feature/foo  ')).toBe('feature/foo');
  });

  it('rejects names longer than 255 characters', () => {
    expect(gitBranchNameSchema.safeParse('a'.repeat(255)).success).toBe(true);
    expect(gitBranchNameSchema.safeParse('a'.repeat(256)).success).toBe(false);
  });
});
