const { mockEvaluateDecisionModel, mockPromptRows } = vi.hoisted(() => ({
  mockEvaluateDecisionModel: vi.fn(),
  mockPromptRows: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  asc: vi.fn(),
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
  contentBlocks: [{ type: 'text', text }],
  payload: null,
});

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
    mockPromptRows
      .mockReset()
      .mockResolvedValue([
        prompt('Remove the duplicate-call guard.'),
        prompt('Also drop the helper.'),
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
    // One check per coding turn: the helper-model fallback stays available.
    expect(call.highVolume).toBeUndefined();
    expect(Object.keys(call.questions)).toEqual([
      'requestUnaddressed',
      'reportOverclaims',
      'leftoverArtifacts',
    ]);
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
      },
    });

    expect(
      JSON.stringify(mockEvaluateDecisionModel.mock.calls[0]![0].state),
    ).not.toContain('ghp_aaaa');
  });

  it('is skipped without a request, without a decision model, or on failure', async () => {
    mockPromptRows.mockResolvedValueOnce([]);
    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({ status: 'skipped', flags: [] });
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();

    mockEvaluateDecisionModel.mockResolvedValueOnce(null);
    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({ status: 'skipped', flags: [] });

    mockEvaluateDecisionModel.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({ status: 'skipped', flags: [] });
  });
});
