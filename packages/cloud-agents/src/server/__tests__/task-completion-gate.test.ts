const { mockEvaluateDecisionModel, mockPromptRows } = vi.hoisted(() => ({
  mockEvaluateDecisionModel: vi.fn(),
  mockPromptRows: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  sql: vi.fn(),
  taskMessages: {},
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: mockPromptRows }) }),
      }),
    }),
  },
}));

vi.mock('../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluateDecisionModel,
}));

import { evaluateTaskCompletionGate } from '../task-completion-gate';

const prompt = (text: string) => ({
  id: text,
  contentBlocks: [{ type: 'text', text }],
  payload: null,
});

/** The gate scans oldest-first for the opening, then newest-first. */
function mockTranscript(prompts: string[], scanLimit = 12): void {
  const rows = prompts.map(prompt);
  mockPromptRows
    .mockReset()
    .mockResolvedValueOnce(rows.slice(0, scanLimit))
    .mockResolvedValueOnce([...rows].reverse().slice(0, scanLimit));
}

const check = {
  report: 'Removed the guard and its tests.',
  diffStat: ' src/guard.ts | 40 ----',
  diff: 'diff --git a/src/guard.ts b/src/guard.ts\n-export const guard = true;\n',
  diffTruncated: false,
};

function answers(
  overrides: Partial<
    Record<
      'requestUnaddressed' | 'reportOverclaims' | 'leftoverArtifacts',
      number
    >
  > = {},
) {
  return Object.fromEntries(
    Object.entries({
      requestUnaddressed: 0.04,
      reportOverclaims: 0.03,
      leftoverArtifacts: 0.02,
      ...overrides,
    }).map(([id, noul]) => [id, { type: 'noul', noul }]),
  );
}

describe('evaluateTaskCompletionGate', () => {
  beforeEach(() => {
    mockTranscript([
      'Remove the duplicate-call guard.',
      'Also drop the helper.',
    ]);
    mockEvaluateDecisionModel.mockReset().mockResolvedValue(answers());
  });

  it('is clear when no judgment crosses the threshold', async () => {
    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({ status: 'clear', flags: [] });

    const call = mockEvaluateDecisionModel.mock.calls[0]![0];

    expect(call.state).toMatchObject({
      request: 'Remove the duplicate-call guard.',
      follow_ups: 'Also drop the helper.',
      report: check.report,
      diff: check.diff,
    });
    // Hosted judgment model only: the helper fallback is ruled out.
    expect(call.highVolume).toBe(true);
    expect(Object.keys(call.questions)).toEqual([
      'requestUnaddressed',
      'reportOverclaims',
      'leftoverArtifacts',
    ]);
  });

  it('keeps the opening prompt and the newest follow-ups on a long task', async () => {
    mockTranscript([
      'Remove the duplicate-call guard.',
      ...Array.from({ length: 60 }, (_, index) => `Follow-up ${index + 1}.`),
    ]);

    await evaluateTaskCompletionGate({ taskId: 'task-1', check });

    expect(mockEvaluateDecisionModel.mock.calls[0]![0].state).toMatchObject({
      request: 'Remove the duplicate-call guard.',
      follow_ups: [56, 57, 58, 59, 60]
        .map((index) => `Follow-up ${index}.`)
        .join('\n\n'),
    });
  });

  it('does not repeat a lone opening prompt as its own follow-up', async () => {
    mockTranscript(['Remove the duplicate-call guard.']);

    await evaluateTaskCompletionGate({ taskId: 'task-1', check });

    expect(mockEvaluateDecisionModel.mock.calls[0]![0].state).toMatchObject({
      request: 'Remove the duplicate-call guard.',
      follow_ups: '',
    });
  });

  it('flags only confident judgments', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(
      answers({ requestUnaddressed: 0.91, leftoverArtifacts: 0.7 }),
    );

    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({
      status: 'flagged',
      flags: [{ id: 'requestUnaddressed', probability: 0.91 }],
    });
  });

  it('does not ask whether a change is present when the diff was clipped', async () => {
    mockEvaluateDecisionModel.mockResolvedValue({
      leftoverArtifacts: { type: 'noul', noul: 0.1 },
    });

    await evaluateTaskCompletionGate({
      taskId: 'task-1',
      check: { ...check, diffTruncated: true },
    });

    expect(
      Object.keys(mockEvaluateDecisionModel.mock.calls[0]![0].questions),
    ).toEqual(['leftoverArtifacts']);
  });

  it('redacts credentials before the diff leaves the deployment', async () => {
    await evaluateTaskCompletionGate({
      taskId: 'task-1',
      check: {
        ...check,
        diff: `${check.diff}+const key = "ghp_${'a'.repeat(36)}";\n`,
        diffStat: ` config/ghp_${'b'.repeat(36)}.json | 1 +`,
      },
    });

    expect(
      JSON.stringify(mockEvaluateDecisionModel.mock.calls[0]![0].state),
    ).not.toMatch(/ghp_(aaaa|bbbb)/);
  });

  it('is skipped without a request, without a decision model, or on failure', async () => {
    mockTranscript([]);
    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({ status: 'skipped', flags: [] });
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();

    mockTranscript(['Remove the duplicate-call guard.']);
    mockEvaluateDecisionModel.mockResolvedValueOnce(null);
    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({ status: 'skipped', flags: [] });

    mockTranscript(['Remove the duplicate-call guard.']);
    mockEvaluateDecisionModel.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({ status: 'skipped', flags: [] });
  });
});
