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

    it('screens files whose paths git quotes', () => {
      const diff = [
        'diff --git "a/src/my file.ts" "b/src/my file.ts"',
        'index 1111111..2222222 100644',
        '--- "a/src/my file.ts"',
        '+++ "b/src/my file.ts"',
        '@@ -1,1 +1,1 @@',
        '+spaced',
        'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
        '--- "a/src/caf\\303\\251.ts"',
        '+++ "b/src/caf\\303\\251.ts"',
        '@@ -1,1 +1,1 @@',
        '+accented',
      ].join('\n');

      expect(
        selectReviewPrescreenHunks(diff).map((selected) => selected.file),
      ).toEqual(['src/my file.ts', 'src/café.ts']);
    });

    it('anchors deletion-only hunks to where the removal happened', () => {
      const diff = [
        fileDiff('src/keep.ts', []),
        '@@ -10,2 +9,0 @@ function scope()',
        '-removed one',
        '-removed two',
        'diff --git a/src/gone.ts b/src/gone.ts',
        'deleted file mode 100644',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-everything',
      ].join('\n');

      const hunks = selectReviewPrescreenHunks(diff);

      expect(hunks).toMatchObject([
        { file: 'src/keep.ts', startLine: 9, endLine: 8 },
        { file: 'src/gone.ts', startLine: 0, endLine: -1 },
      ]);

      const text = formatReviewPrescreenHints(
        collectReviewPrescreenHints(hunks, {
          h0: noul(0.8),
          h1: noul(0.7),
        }),
      );

      expect(text).toContain('`src/keep.ts` lines removed after line 9');
      expect(text).toContain(
        '`src/gone.ts` lines removed at the start of the file',
      );
    });

    it('chunks oversized hunks into inspectable regions with their own ranges', () => {
      const newFile = [
        'diff --git a/src/new.ts b/src/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1,120 @@',
        ...Array.from({ length: 120 }, (_, index) => `+line ${index + 1}`),
      ].join('\n');
      const mixed = fileDiff('src/mixed.ts', [
        {
          start: 10,
          lines: [
            ...Array.from({ length: 49 }, (_, index) => ` context ${index}`),
            '-removed',
            '+added',
            ' context tail',
          ],
        },
      ]);
      const deleted = [
        'diff --git a/src/gone.ts b/src/gone.ts',
        'deleted file mode 100644',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1,60 +0,0 @@',
        ...Array.from({ length: 60 }, (_, index) => `-old ${index + 1}`),
      ].join('\n');

      const hunks = selectReviewPrescreenHunks(
        [newFile, mixed, deleted].join('\n'),
        { chunkLines: 50 },
      );
      const summary = hunks.map(({ file, header, startLine, endLine }) => ({
        file,
        header,
        startLine,
        endLine,
      }));

      expect(summary.filter((hunk) => hunk.file === 'src/new.ts')).toEqual([
        {
          file: 'src/new.ts',
          header: '@@ -0,0 +1,50 @@',
          startLine: 1,
          endLine: 50,
        },
        {
          file: 'src/new.ts',
          header: '@@ -0,0 +51,50 @@',
          startLine: 51,
          endLine: 100,
        },
        {
          file: 'src/new.ts',
          header: '@@ -0,0 +101,20 @@',
          startLine: 101,
          endLine: 120,
        },
      ]);
      // The chunk boundary falls inside the `-removed`/`+added` pair, so the
      // chunk extends to keep it whole; the context-only remainder is dropped.
      expect(summary.filter((hunk) => hunk.file === 'src/mixed.ts')).toEqual([
        {
          file: 'src/mixed.ts',
          header: '@@ -10,50 +10,50 @@ function scope()',
          startLine: 10,
          endLine: 59,
        },
      ]);
      expect(summary.filter((hunk) => hunk.file === 'src/gone.ts')).toEqual([
        {
          file: 'src/gone.ts',
          header: '@@ -1,50 +0,0 @@',
          startLine: 0,
          endLine: -1,
        },
        {
          file: 'src/gone.ts',
          header: '@@ -51,10 +0,0 @@',
          startLine: 0,
          endLine: -1,
        },
      ]);
      expect(hunks.find((hunk) => hunk.startLine === 51)!.text).toContain(
        '+line 51',
      );
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
    it('ranks hunks by defect probability instead of using an absolute cutoff', () => {
      const hunks = [
        hunk('src/a.ts', 1),
        hunk('src/b.ts', 1),
        hunk('src/c.ts', 1),
        hunk('src/d.ts', 1),
        hunk('src/e.ts', 1),
      ];

      const hints = collectReviewPrescreenHints(hunks, {
        h0: noul(0.32),
        h0Area: area('security', 0.8),
        // Top-ranked even though well under 0.5; the area is too unsure to name.
        h1: noul(0.41),
        h1Area: area('correctness', 0.3),
        // Below the clean-hunk floor.
        h2: noul(0.05),
        h2Area: area('performance', 0.9),
        // Malformed probability and unknown area.
        h3: noul(Number.NaN),
        h3Area: area('style', 0.9),
        h4: noul(0.2),
        h4Area: area('style', 0.9),
      });

      expect(hints).toEqual([
        expect.objectContaining({
          file: 'src/b.ts',
          rank: 1,
          screenedHunks: 4,
        }),
        expect.objectContaining({
          file: 'src/a.ts',
          rank: 2,
          area: 'security',
        }),
        expect.objectContaining({ file: 'src/e.ts', rank: 3 }),
      ]);
      expect(hints[0]).not.toHaveProperty('area');
      expect(hints[2]).not.toHaveProperty('area');
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
        '- `src/a.ts` lines 12-13 (`@@ -12,2 +12,2 @@`): ranked 1 of 1 screened hunks, most likely a concurrency or lifecycle issue.',
      );
      expect(text).toContain('never clears code');
    });
  });

  describe('runGithubPrReviewPrescreen', () => {
    it('asks a defect and an area question per hunk through the high-volume decision model', async () => {
      mockEvaluateDecisionModel.mockResolvedValue({
        h0: noul(0.05),
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
