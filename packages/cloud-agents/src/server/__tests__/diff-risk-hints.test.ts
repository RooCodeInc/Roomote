const { mockScreenReviewHunks } = vi.hoisted(() => ({
  mockScreenReviewHunks: vi.fn(),
}));

vi.mock('../workflows/githubPrReviewPrescreen', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../workflows/githubPrReviewPrescreen')
  >()),
  screenReviewHunks: mockScreenReviewHunks,
}));

import { screenDiffRiskHints } from '../diff-risk-hints';

const diff = [
  'diff --git a/src/guard.ts b/src/guard.ts',
  '--- a/src/guard.ts',
  '+++ b/src/guard.ts',
  '@@ -10,3 +10,3 @@ export function allow(user) {',
  '-  return user.admin;',
  '+  return !user.admin;',
  'diff --git a/src/new.ts b/src/new.ts',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export const x = 1;',
].join('\n');

describe('screenDiffRiskHints', () => {
  beforeEach(() => mockScreenReviewHunks.mockReset());

  it('screens the diff with the task title and every changed file', async () => {
    mockScreenReviewHunks.mockResolvedValue([
      {
        file: 'src/guard.ts',
        header: '@@ -10,3 +10,3 @@ export function allow(user) {',
        startLine: 10,
        endLine: 12,
        area: 'security',
        defectProbability: 0.6,
        rank: 1,
        screenedHunks: 2,
      },
    ]);

    const result = await screenDiffRiskHints({
      title: 'Fix admin check',
      diff,
    });

    expect(mockScreenReviewHunks).toHaveBeenCalledWith({
      title: 'Fix admin check',
      changedFiles: ['src/guard.ts', 'src/new.ts'],
      diff,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.text).toContain('`src/guard.ts`');
    expect(result.text).toContain('possible security issue');
    expect(result.text).toContain('Each line is a question, not a finding.');
  });

  it('says nothing was flagged without claiming the change is clear', async () => {
    mockScreenReviewHunks.mockResolvedValue([]);

    const result = await screenDiffRiskHints({ diff });

    expect(result).toMatchObject({ available: true, hints: [] });
    if (!result.available) return;
    expect(result.text).toContain('does not clear the change');
  });

  it('reports unavailable when there is no judgment model or nothing reviewable', async () => {
    mockScreenReviewHunks.mockResolvedValue(undefined);

    await expect(screenDiffRiskHints({ diff })).resolves.toMatchObject({
      available: false,
    });
  });
});
