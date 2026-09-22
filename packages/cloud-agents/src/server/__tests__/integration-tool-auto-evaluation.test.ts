const { mockEvaluate, mockRecord } = vi.hoisted(() => ({
  mockEvaluate: vi.fn(),
  mockRecord: vi.fn(async () => undefined),
}));

vi.mock('../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluate,
}));
vi.mock('@roomote/db/server', async () => ({
  recordIntegrationToolAutoEvaluation: mockRecord,
  redactIntegrationToolArgs: (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, item) =>
        key === 'apiKey' ? '[redacted]' : item,
      ),
    ),
}));

import {
  evaluateIntegrationToolAutoDecision,
  recommendFromAutoAnswers,
  recordIntegrationToolAutoEvaluationInBackground,
} from '../integration-tool-auto-evaluation';

const safe = {
  matchesRequest: 0.95,
  readOnlyOrReversible: 0.9,
  destructive: 0.05,
  reachesOutside: 0.05,
  looksInjected: 0.02,
};
const asAnswers = (values: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }]),
  );
const call = {
  integrationId: 'linear',
  toolName: 'list_issues',
  args: { team: 'ENG', apiKey: 'sk-live' },
  userRequest: 'What is open for ENG?',
  userId: 'user-1',
};

beforeEach(() => vi.clearAllMocks());

describe('recommendFromAutoAnswers', () => {
  it('recommends running only a call every answer clearly clears', () => {
    expect(recommendFromAutoAnswers(safe)).toBe('approve');
    for (const unsure of [
      { matchesRequest: 0.6 },
      { readOnlyOrReversible: 0.5 },
      { destructive: 0.3 },
      { reachesOutside: 0.9 },
      { looksInjected: 0.4 },
    ]) {
      expect(recommendFromAutoAnswers({ ...safe, ...unsure })).toBe('ask');
    }
  });
});

describe('evaluateIntegrationToolAutoDecision', () => {
  it('shows the model the redacted call and the request, and keeps its answers', async () => {
    mockEvaluate.mockResolvedValue(asAnswers(safe));
    const evaluation = await evaluateIntegrationToolAutoDecision(call);
    expect(evaluation).toMatchObject({
      recommendation: 'approve',
      answers: safe,
    });
    const { state, userId } = mockEvaluate.mock.calls[0]![0];
    expect(userId).toBe('user-1');
    expect(state).toEqual({
      call: {
        integration: 'linear',
        tool: 'list_issues',
        arguments: { team: 'ENG', apiKey: '[redacted]' },
      },
      userRequest: 'What is open for ENG?',
    });
  });

  it('falls back to asking with no model or a failed evaluation', async () => {
    mockEvaluate.mockResolvedValue(null);
    await expect(
      evaluateIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({
      recommendation: 'ask',
      unavailable: 'no_model',
    });

    mockEvaluate.mockRejectedValue(new Error('timeout'));
    await expect(
      evaluateIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({ recommendation: 'ask', unavailable: 'error' });
  });
});

describe('recordIntegrationToolAutoEvaluationInBackground', () => {
  it('records the evaluation on the approval and never throws', async () => {
    mockEvaluate.mockResolvedValue(asAnswers({ ...safe, destructive: 0.9 }));
    recordIntegrationToolAutoEvaluationInBackground('approval-1', call);
    await vi.waitFor(() =>
      expect(mockRecord).toHaveBeenCalledWith(
        'approval-1',
        expect.objectContaining({ recommendation: 'ask' }),
      ),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRecord.mockRejectedValueOnce(new Error('db down'));
    recordIntegrationToolAutoEvaluationInBackground('approval-2', call);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
