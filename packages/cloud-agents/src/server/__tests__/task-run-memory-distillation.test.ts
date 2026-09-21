const {
  mockEvaluateDecisionModel,
  mockGenerateTrackedNonTaskObject,
  mockReportRows,
} = vi.hoisted(() => ({
  mockEvaluateDecisionModel: vi.fn(),
  mockGenerateTrackedNonTaskObject: vi.fn(),
  mockReportRows: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  sql: vi.fn(),
  taskMessages: {},
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: mockReportRows }) }),
      }),
    }),
  },
}));

vi.mock('../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluateDecisionModel,
}));

vi.mock('../non-task-provider-usage', () => ({
  generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES: {
    taskMemoryDistillation: 'task_memory_distillation',
  },
}));

import { distillTaskRunMemory } from '../task-run-memory-distillation';

const message = (text: string) => ({
  contentBlocks: [{ type: 'text', text }],
  payload: null,
});

const answers = (reusableKnowledge: number, trivialWork: number) => ({
  reusableKnowledge: { type: 'noul', noul: reusableKnowledge },
  trivialWork: { type: 'noul', noul: trivialWork },
});

const run = {
  runId: 102,
  taskId: 'task-1',
  userId: 'user-1',
  request: 'Fix the flaky checkout test',
};

describe('distillTaskRunMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Newest first, as the query returns them.
    mockReportRows.mockResolvedValue([
      message('Pinned the fixture clock; the cart cache TTL caused the flake.'),
      message('Looking at the test now.'),
    ]);
    mockEvaluateDecisionModel.mockResolvedValue(answers(0.94, 0.06));
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        outcome: 'Pinned the fixture clock.',
        rationale: 'Production relies on the tax-rate cache.',
        reusableFacts: ['The cart service caches tax rates for 60s.'],
      },
    });
  });

  it('judges the closing report in order and renders the distilled memory', async () => {
    const summary = await distillTaskRunMemory(run);

    expect(mockEvaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        highVolume: true,
        taskId: 'task-1',
        state: {
          request: run.request,
          report:
            'Looking at the test now.\n\nPinned the fixture clock; the cart cache TTL caused the flake.',
        },
      }),
    );
    expect(summary).toContain('## Outcome\n\nPinned the fixture clock.');
    expect(summary).toContain('## Why');
    expect(summary).toContain('- The cart service caches tax rates for 60s.');
    expect(summary).toContain('the agent did not record a memory');
  });

  it('skips trivial or unremarkable runs without calling the helper model', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(answers(0.12, 0.96));
    await expect(distillTaskRunMemory(run)).resolves.toBeNull();

    mockEvaluateDecisionModel.mockResolvedValueOnce(answers(0.9, 0.7));
    await expect(distillTaskRunMemory(run)).resolves.toBeNull();

    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('skips when only the helper fallback is available, or the run has no report', async () => {
    mockEvaluateDecisionModel.mockResolvedValueOnce(null);
    await expect(distillTaskRunMemory(run)).resolves.toBeNull();

    mockReportRows.mockResolvedValueOnce([]);
    await expect(distillTaskRunMemory(run)).resolves.toBeNull();

    expect(mockEvaluateDecisionModel).toHaveBeenCalledTimes(1);
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('never throws when a model call fails', async () => {
    mockEvaluateDecisionModel.mockRejectedValueOnce(new Error('jev timeout'));
    await expect(distillTaskRunMemory(run)).resolves.toBeNull();

    mockGenerateTrackedNonTaskObject.mockRejectedValueOnce(
      new Error('helper unavailable'),
    );
    await expect(distillTaskRunMemory(run)).resolves.toBeNull();
  });
});
