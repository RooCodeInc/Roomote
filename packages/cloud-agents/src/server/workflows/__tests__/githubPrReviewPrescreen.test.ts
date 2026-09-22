const { mockEvaluateDecisionModel } = vi.hoisted(() => ({
  mockEvaluateDecisionModel: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluateDecisionModel,
}));

import {
  collectReviewPrescreenHints,
  formatReviewPrescreenHints,
  REVIEW_PRESCREEN_MAX_HINTS,
  REVIEW_PRESCREEN_MAX_HINTS_PER_FILE,
  REVIEW_PRESCREEN_TIMEOUT_MS,
  runGithubPrReviewPrescreen,
  selectReviewPrescreenHunks,
  type ReviewPrescreenHunk,
} from '../githubPrReviewPrescreen';

function fileDiff(
  file: string,
  hunks: Array<{ start: number; lines: string[] }>,
): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    ...hunks.flatMap(({ start, lines }) => [
      `@@ -${start},${lines.length} +${start},${lines.length} @@ function scope()`,
      ...lines,
    ]),
  ].join('\n');
}

function noul(value: number) {
  return { type: 'noul' as const, noul: value };
}

function area(choice: string, confidence: number) {
  return {
    type: 'choice' as const,
    choice,
    probabilities: { [choice]: confidence },
    confidence,
  };
}

function hunk(file: string, startLine: number): ReviewPrescreenHunk {
  return {
    file,
    header: `@@ -${startLine},2 +${startLine},2 @@`,
    startLine,
    endLine: startLine + 1,
    text: '+changed',
  };
}

describe('github PR review pre-screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hunk selection', () => {
    it('parses head-side hunk ranges and skips lockfiles and context-only hunks', () => {
      const diff = [
        fileDiff('src/auth.ts', [
          { start: 10, lines: [' keep', '-old', '+new', ' keep'] },
          { start: 40, lines: [' only', ' context'] },
        ]),
        fileDiff('pnpm-lock.yaml', [{ start: 1, lines: ['+lock: 1'] }]),
      ].join('\n');

      const hunks = selectReviewPrescreenHunks(diff);

      expect(hunks).toHaveLength(1);
      expect(hunks[0]).toMatchObject({
        file: 'src/auth.ts',
        header: '@@ -10,4 +10,4 @@ function scope()',
        startLine: 10,
        endLine: 13,
      });
      expect(hunks[0]!.text).toContain('+new');
    });

    it('covers every file before a second hunk from any file', () => {
      const diff = [
        fileDiff(
          'src/big.ts',
          Array.from({ length: 10 }, (_, index) => ({
            start: index * 100 + 1,
            lines: [`+big ${index}`],
          })),
        ),
        fileDiff('src/late-a.ts', [{ start: 1, lines: ['+late a'] }]),
        fileDiff('src/late-b.ts', [{ start: 1, lines: ['+late b'] }]),
      ].join('\n');

      const hunks = selectReviewPrescreenHunks(diff, { maxHunks: 4 });

      expect(hunks.map((selected) => selected.file)).toEqual([
        'src/big.ts',
        'src/late-a.ts',
        'src/late-b.ts',
        'src/big.ts',
      ]);
    });

    it('splits the character budget fairly instead of truncating later files', () => {
      const huge = Array.from(
        { length: 2_000 },
        (_, index) => `+line ${index}`,
      );
      const diff = [
        fileDiff('src/huge.ts', [{ start: 1, lines: huge }]),
        fileDiff('src/small.ts', [{ start: 5, lines: ['+small change'] }]),
      ].join('\n');

      const hunks = selectReviewPrescreenHunks(diff, { maxInputChars: 2_000 });
      const small = hunks.find((selected) => selected.file === 'src/small.ts');
      const large = hunks.find((selected) => selected.file === 'src/huge.ts');

      expect(small!.text).toContain('+small change');
      expect(small!.text).not.toContain('truncated');
      expect(large!.text).toContain('[... hunk truncated for pre-screen]');
      expect(
        hunks.reduce((total, selected) => total + selected.text.length, 0),
      ).toBeLessThanOrEqual(2_000);
    });
  });

  describe('hint collection', () => {
    it('keeps only hunks with a confident defect and a confident area', () => {
      const hunks = [
        hunk('src/a.ts', 1),
        hunk('src/b.ts', 1),
        hunk('src/c.ts', 1),
        hunk('src/d.ts', 1),
      ];

      const hints = collectReviewPrescreenHints(hunks, {
        h0: noul(0.9),
        h0Area: area('security', 0.8),
        // Likely defect but the model cannot say what kind: unsupported.
        h1: noul(0.95),
        h1Area: area('correctness', 0.3),
        // Below the defect floor.
        h2: noul(0.6),
        h2Area: area('performance', 0.9),
        // Malformed probability and unknown area.
        h3: noul(Number.NaN),
        h3Area: area('style', 0.9),
      });

      expect(hints).toEqual([
        expect.objectContaining({
          file: 'src/a.ts',
          area: 'security',
          defectProbability: 0.9,
        }),
      ]);
    });

    it('caps hints per file and overall, strongest first', () => {
      const hunks = [
        ...Array.from({ length: 4 }, (_, index) => hunk('src/hot.ts', index)),
        ...Array.from({ length: 8 }, (_, index) => hunk(`src/f${index}.ts`, 1)),
      ];
      const answers = Object.fromEntries(
        hunks.flatMap((_, index) => [
          [`h${index}`, noul(0.99 - index * 0.01)],
          [`h${index}Area`, area('correctness', 0.9)],
        ]),
      );

      const hints = collectReviewPrescreenHints(hunks, answers);

      expect(hints).toHaveLength(REVIEW_PRESCREEN_MAX_HINTS);
      expect(hints.filter((hint) => hint.file === 'src/hot.ts')).toHaveLength(
        REVIEW_PRESCREEN_MAX_HINTS_PER_FILE,
      );
      expect(hints[0]!.defectProbability).toBeGreaterThan(
        hints.at(-1)!.defectProbability,
      );
    });

    it('formats hints as anchored hunks and never emits an all-clear', () => {
      expect(formatReviewPrescreenHints([])).toBeUndefined();

      const text = formatReviewPrescreenHints(
        collectReviewPrescreenHints([hunk('src/a.ts', 12)], {
          h0: noul(0.82),
          h0Area: area('concurrency', 0.71),
        }),
      );

      expect(text).toContain(
        '- `src/a.ts` lines 12-13 (`@@ -12,2 +12,2 @@`): possible concurrency or lifecycle defect (defect 82%, area 71%).',
      );
      expect(text).toContain('never clears code');
    });
  });

  describe('runGithubPrReviewPrescreen', () => {
    it('asks a defect and an area question per hunk through the high-volume decision model', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        h0: noul(0.1),
        h0Area: area('correctness', 0.6),
        h1: noul(0.88),
        h1Area: area('security', 0.77),
      });

      const hints = await runGithubPrReviewPrescreen({
        title: 'Harden webhook validation',
        changedFiles: ['src/webhook.ts', 'src/auth.ts'],
        diff: [
          fileDiff('src/webhook.ts', [{ start: 3, lines: ['+validate();'] }]),
          fileDiff('src/auth.ts', [{ start: 7, lines: ['-check();'] }]),
        ].join('\n'),
      });

      expect(mockEvaluateDecisionModel).toHaveBeenCalledTimes(1);
      const request = mockEvaluateDecisionModel.mock.calls[0]![0] as {
        state: {
          title: string;
          changedFiles: string[];
          hunks: Record<string, { file: string; diff: string }>;
        };
        questions: Record<string, { type: string }>;
        timeoutMs: number;
        highVolume: boolean;
      };
      expect(request).toMatchObject({
        timeoutMs: REVIEW_PRESCREEN_TIMEOUT_MS,
        highVolume: true,
      });
      expect(request.state.title).toBe('Harden webhook validation');
      expect(Object.keys(request.state.hunks)).toEqual(['h0', 'h1']);
      expect(request.state.hunks.h1!.file).toBe('src/auth.ts');
      expect(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          question.type,
        ]),
      ).toEqual([
        ['h0', 'noul'],
        ['h0Area', 'choice'],
        ['h1', 'noul'],
        ['h1Area', 'choice'],
      ]);
      expect(hints).toContain('`src/auth.ts` lines 7-7');
      expect(hints).not.toContain('src/webhook.ts');
    });

    it('splits large diffs into parallel batches with globally unique keys', async () => {
      mockEvaluateDecisionModel.mockImplementation(
        async ({ questions }: { questions: Record<string, unknown> }) =>
          Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              id.endsWith('Area') ? area('correctness', 0.9) : noul(0.1),
            ]),
          ),
      );

      await runGithubPrReviewPrescreen({
        changedFiles: [],
        diff: Array.from({ length: 40 }, (_, index) =>
          fileDiff(`src/f${index}.ts`, [{ start: 1, lines: ['+x'] }]),
        ).join('\n'),
      });

      expect(mockEvaluateDecisionModel).toHaveBeenCalledTimes(2);
      const keys = mockEvaluateDecisionModel.mock.calls.flatMap(([request]) =>
        Object.keys((request as { questions: object }).questions),
      );
      expect(new Set(keys).size).toBe(80);
      expect(keys).toContain('h39Area');
    });

    it('continues without hints when no decision model is configured', async () => {
      mockEvaluateDecisionModel.mockResolvedValue(null);

      await expect(
        runGithubPrReviewPrescreen({
          changedFiles: ['src/index.ts'],
          diff: fileDiff('src/index.ts', [{ start: 1, lines: ['+x'] }]),
        }),
      ).resolves.toBeUndefined();
    });

    it('swallows decision-model failures without logging review content', async () => {
      mockEvaluateDecisionModel.mockRejectedValue(
        new Error('upstream echoed secret diff contents'),
      );
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        runGithubPrReviewPrescreen({
          changedFiles: ['src/index.ts'],
          diff: fileDiff('src/index.ts', [
            { start: 1, lines: ['+secret diff contents'] },
          ]),
        }),
      ).resolves.toBeUndefined();

      expect(warning).toHaveBeenCalledWith(
        '[GitHubPrReviewPrescreen] Decision model unavailable; continuing without pre-screen hints',
      );
      expect(warning.mock.calls.flat().join(' ')).not.toContain(
        'secret diff contents',
      );
    });

    it('does not call the decision model without reviewable hunks', async () => {
      await expect(
        runGithubPrReviewPrescreen({ changedFiles: [], diff: '  ' }),
      ).resolves.toBeUndefined();
      await expect(
        runGithubPrReviewPrescreen({
          changedFiles: ['pnpm-lock.yaml'],
          diff: fileDiff('pnpm-lock.yaml', [{ start: 1, lines: ['+a'] }]),
        }),
      ).resolves.toBeUndefined();
      expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
    });
  });
});
