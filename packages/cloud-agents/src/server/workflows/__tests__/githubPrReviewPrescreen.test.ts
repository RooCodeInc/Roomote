const { mockEvaluateDecisionModel } = vi.hoisted(() => ({
  mockEvaluateDecisionModel: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluateDecisionModel,
}));

import {
  buildReviewPrescreenState,
  formatReviewPrescreenHints,
  REVIEW_PRESCREEN_MAX_DIFF_CHARS,
  REVIEW_PRESCREEN_MAX_FILE_CHARS,
  REVIEW_PRESCREEN_MAX_FILES,
  REVIEW_PRESCREEN_MAX_HINTS,
  REVIEW_PRESCREEN_TIMEOUT_MS,
  runGithubPrReviewPrescreen,
} from '../githubPrReviewPrescreen';

function answer(noul: number) {
  return { type: 'noul' as const, noul };
}

const allAnswers = {
  security: answer(0.92),
  correctness: answer(0.84),
  dataIntegrity: answer(0.78),
  concurrency: answer(0.72),
  compatibility: answer(0.68),
  failureHandling: answer(0.63),
  performance: answer(0.55),
  tests: answer(0.42),
};

describe('github PR review pre-screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the configured high-volume decision model and returns filtered advisory hints', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(allAnswers);

    const hints = await runGithubPrReviewPrescreen({
      title: 'Harden webhook validation',
      changedFiles: ['src/webhook.ts'],
      diff: 'diff --git a/src/webhook.ts b/src/webhook.ts\n+validate(payload);',
    });

    expect(mockEvaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: REVIEW_PRESCREEN_TIMEOUT_MS,
        highVolume: true,
      }),
    );
    expect(mockEvaluateDecisionModel.mock.calls[0]![0]).not.toHaveProperty(
      'capture',
    );
    expect(mockEvaluateDecisionModel.mock.calls[0]![0]).not.toHaveProperty(
      'shadow',
    );
    const request = mockEvaluateDecisionModel.mock.calls[0]![0] as {
      state: { title: string; changedFiles: string[]; diff: string };
      questions: Record<string, unknown>;
    };
    expect(request.state).toEqual({
      title: 'Harden webhook validation',
      changedFiles: ['src/webhook.ts'],
      diff: expect.stringContaining('validate(payload);'),
    });
    expect(Object.keys(request.questions)).toHaveLength(8);
    expect(hints).toContain('security, authentication, authorization');
    expect(hints).toContain('correctness, behavior, and edge cases');
    expect(hints).not.toContain('performance, latency, and scalability');
    expect(hints).toContain('Independently review the complete diff');
  });

  it('continues without hints when no decision model is configured', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(null);

    await expect(
      runGithubPrReviewPrescreen({
        changedFiles: ['src/index.ts'],
        diff: '+export const value = 1;',
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
        diff: 'secret diff contents',
      }),
    ).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledWith(
      '[GitHubPrReviewPrescreen] Decision model unavailable; continuing without pre-screen hints',
    );
    expect(warning.mock.calls.flat().join(' ')).not.toContain(
      'secret diff contents',
    );
  });

  it('filters low-confidence and malformed answers and caps the hint list', () => {
    const hints = formatReviewPrescreenHints({
      ...allAnswers,
      failureHandling: answer(0.64),
      performance: { type: 'noul', noul: Number.NaN },
      tests: answer(1.2),
    });

    const hintLines = hints!
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(hintLines).toHaveLength(REVIEW_PRESCREEN_MAX_HINTS);
    expect(hints).toContain('security, authentication, authorization');
    expect(hints).not.toContain('failure-handling');
    expect(hints).not.toContain('performance, latency, and scalability');
    expect(hints).not.toContain('test coverage and regression risk');
  });

  it('bounds and serializes the pre-screen state deterministically', () => {
    const files = Array.from(
      { length: REVIEW_PRESCREEN_MAX_FILES + 2 },
      (_, index) => `src/file-${index}.ts`,
    );
    const longFile = `${'a'.repeat(REVIEW_PRESCREEN_MAX_FILE_CHARS + 50)}.ts`;
    const state = buildReviewPrescreenState({
      title: 'A'.repeat(500),
      changedFiles: [longFile, ...files, files[0]!],
      diff: 'x'.repeat(REVIEW_PRESCREEN_MAX_DIFF_CHARS + 100),
    });

    expect(state).toBeDefined();
    expect(state!.title).toHaveLength(300);
    expect(state!.changedFiles).toHaveLength(REVIEW_PRESCREEN_MAX_FILES);
    expect(
      Math.max(...state!.changedFiles.map((file) => file.length)),
    ).toBeLessThanOrEqual(REVIEW_PRESCREEN_MAX_FILE_CHARS);
    expect(state!.changedFiles[0]).toContain('[... file path truncated]');
    expect(state!.diff.length).toBeLessThanOrEqual(
      REVIEW_PRESCREEN_MAX_DIFF_CHARS,
    );
    expect(state!.diff).toContain('[... pre-screen diff truncated]');
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('does not call the decision model for an empty diff', async () => {
    await expect(
      runGithubPrReviewPrescreen({
        changedFiles: ['src/index.ts'],
        diff: '  ',
      }),
    ).resolves.toBeUndefined();
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
  });
});
