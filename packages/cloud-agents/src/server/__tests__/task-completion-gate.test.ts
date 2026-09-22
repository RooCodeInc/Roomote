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

const prompt = (text: string, source?: string) => ({
  id: text,
  contentBlocks: [{ type: 'text', text }],
  payload: source ? { source } : null,
  metadata: source ? { source, visibleInTranscript: false } : null,
});

/**
 * The gate scans prompts oldest-first for the opening, then newest-first, and
 * then reads the latest plan.
 */
function mockTranscript(
  prompts: Array<string | ReturnType<typeof prompt>>,
  options: { plan?: string; scanLimit?: number } = {},
): void {
  const rows = prompts.map((entry) =>
    typeof entry === 'string' ? prompt(entry) : entry,
  );
  const scanLimit = options.scanLimit ?? 12;
  mockPromptRows
    .mockReset()
    .mockResolvedValueOnce(rows.slice(0, scanLimit))
    .mockResolvedValueOnce([...rows].reverse().slice(0, scanLimit))
    .mockResolvedValueOnce(options.plan ? [prompt(options.plan)] : []);
}

const check = {
  report: 'Removed the guard and its tests.',
  diffStat: ' src/guard.ts | 40 ----',
  diff: 'diff --git a/src/guard.ts b/src/guard.ts\n-export const guard = true;\n',
  diffTruncated: false,
  commands: [
    {
      command: 'pnpm vitest run src/guard.test.ts',
      exitCode: 0,
      outputTail: 'Tests  12 passed (12)',
      ranBeforeLaterEdit: false,
    },
  ],
};

function answers(
  overrides: Partial<
    Record<
      | 'requestUnaddressed'
      | 'planIncomplete'
      | 'reportOverclaims'
      | 'validationContradicted'
      | 'validationMissing'
      | 'proofClaimDoubtful'
      | 'evidentDefect'
      | 'leftoverArtifacts',
      number
    >
  > = {},
) {
  return Object.fromEntries(
    Object.entries({
      requestUnaddressed: 0.04,
      reportOverclaims: 0.03,
      validationContradicted: 0.03,
      validationMissing: 0.02,
      proofClaimDoubtful: 0.02,
      evidentDefect: 0.02,
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
    expect(call.state).toMatchObject({
      plan: '',
      diff_truncated: false,
      commands: {
        c1: {
          command: 'pnpm vitest run src/guard.test.ts',
          exit_code: 0,
          output_tail: 'Tests  12 passed (12)',
        },
      },
    });
    // Everything the judge pass used to weigh, minus the checklist question
    // when the task never made a checklist.
    expect(Object.keys(call.questions)).toEqual([
      'requestUnaddressed',
      'reportOverclaims',
      'validationContradicted',
      'validationMissing',
      'proofClaimDoubtful',
      'evidentDefect',
      'leftoverArtifacts',
    ]);
  });

  it("holds the report against the agent's own checklist when there is one", async () => {
    mockTranscript(['Remove the duplicate-call guard.'], {
      plan: '- [completed] Remove the guard\n- [pending] Update the docs',
    });
    mockEvaluateDecisionModel.mockResolvedValue(
      answers({ planIncomplete: 0.9 }),
    );

    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({
      status: 'flagged',
      flags: [{ id: 'planIncomplete', probability: 0.9 }],
    });

    const call = mockEvaluateDecisionModel.mock.calls[0]![0];

    expect(call.state.plan).toBe(
      '- [completed] Remove the guard\n- [pending] Update the docs',
    );
    expect(Object.keys(call.questions)).toContain('planIncomplete');
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

  it('reads a request that arrived as a hidden prompt, as a delegated task gets it', async () => {
    mockTranscript([
      '<request>Remove the duplicate-call guard.</request>\n<hidden>true</hidden>',
    ]);

    await evaluateTaskCompletionGate({ taskId: 'task-1', check });

    expect(mockEvaluateDecisionModel).toHaveBeenCalledTimes(1);
    expect(mockEvaluateDecisionModel.mock.calls[0]![0].state.request).toContain(
      'Remove the duplicate-call guard.',
    );
  });

  it("never reads the harness's own reminders back as requests", async () => {
    mockTranscript([
      'Remove the duplicate-call guard.',
      prompt(
        'Roomote automatically compared what was asked, your closing report, and everything this task changed, and flagged the following: ...',
        'opencode-completion-gate',
      ),
      prompt(
        'Before finalizing, post a terminal chat-visible reply.',
        'opencode-stop-hook',
      ),
    ]);

    await evaluateTaskCompletionGate({ taskId: 'task-1', check });

    expect(mockEvaluateDecisionModel.mock.calls[0]![0].state).toMatchObject({
      request: 'Remove the duplicate-call guard.',
      follow_ups: '',
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

  it('flags a contradicted validation claim at its own lower threshold', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(
      answers({ validationContradicted: 0.7, evidentDefect: 0.7 }),
    );

    await expect(
      evaluateTaskCompletionGate({ taskId: 'task-1', check }),
    ).resolves.toEqual({
      status: 'flagged',
      flags: [{ id: 'validationContradicted', probability: 0.7 }],
    });
  });

  it('leaves out a validation run that predates the last source edit', async () => {
    await evaluateTaskCompletionGate({
      taskId: 'task-1',
      check: {
        ...check,
        commands: [
          { ...check.commands[0]!, ranBeforeLaterEdit: true },
          {
            command: 'git status --short',
            exitCode: 0,
            outputTail: ' M src/guard.ts',
            ranBeforeLaterEdit: false,
          },
        ],
      },
    });

    expect(mockEvaluateDecisionModel.mock.calls[0]![0].state.commands).toEqual({
      c1: {
        command: 'git status --short',
        exit_code: 0,
        output_tail: ' M src/guard.ts',
      },
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

  it('keeps every question on a clipped diff and tells the model it is clipped', async () => {
    await evaluateTaskCompletionGate({
      taskId: 'task-1',
      check: { ...check, diffTruncated: true },
    });

    const call = mockEvaluateDecisionModel.mock.calls[0]![0];

    expect(call.state.diff_truncated).toBe(true);
    expect(Object.keys(call.questions)).toContain('requestUnaddressed');
    expect(call.questions.requestUnaddressed.instructions).toContain(
      'When `diff_truncated` is true',
    );
  });

  it('redacts credentials before the diff leaves the deployment', async () => {
    await evaluateTaskCompletionGate({
      taskId: 'task-1',
      check: {
        ...check,
        diff: `${check.diff}+const key = "ghp_${'a'.repeat(36)}";\n`,
        diffStat: ` config/ghp_${'b'.repeat(36)}.json | 1 +`,
        commands: [
          {
            command: `curl -H "Authorization: Bearer ghp_${'c'.repeat(36)}" https://example.com`,
            exitCode: 0,
            outputTail: `token=ghp_${'d'.repeat(36)}`,
            ranBeforeLaterEdit: false,
          },
        ],
      },
    });

    expect(
      JSON.stringify(mockEvaluateDecisionModel.mock.calls[0]![0].state),
    ).not.toMatch(/ghp_(aaaa|bbbb|cccc|dddd)/);
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
