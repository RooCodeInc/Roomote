const { mockEvaluate, mockRecord, mockSettings } = vi.hoisted(() => ({
  mockEvaluate: vi.fn(),
  mockRecord: vi.fn(async () => undefined),
  mockSettings: vi.fn(async () => ({ mode: 'shadow', policy: '' })),
}));

vi.mock('../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluate,
}));
vi.mock('@roomote/db/server', async () => ({
  getIntegrationToolAutoSettings: mockSettings,
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
  resolveIntegrationToolAutoDecision,
} from '../integration-tool-auto-evaluation';

const safe = {
  matchesRequest: 0.95,
  allowedByPolicy: 0.9,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.mockResolvedValue({ mode: 'shadow', policy: '' });
});

describe('recommendFromAutoAnswers', () => {
  it('recommends running only a call every answer clearly clears', () => {
    expect(recommendFromAutoAnswers(safe)).toBe('approve');
    for (const unsure of [
      { matchesRequest: 0.6 },
      { allowedByPolicy: 0.5 },
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
  it('shows the model the redacted call, the request and the policy, and keeps its answers', async () => {
    mockEvaluate.mockResolvedValue(asAnswers(safe));
    mockSettings.mockResolvedValue({ mode: 'on', policy: 'Reads only.' });
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
      autoPolicy: 'Reads only.',
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

describe('resolveIntegrationToolAutoDecision', () => {
  it('asks when off, shadows when shadow, and evaluates only when on', async () => {
    mockSettings.mockResolvedValue({ mode: 'off', policy: '' });
    await expect(resolveIntegrationToolAutoDecision(call)).resolves.toEqual({
      action: 'ask',
      mode: 'off',
    });
    mockSettings.mockResolvedValue({ mode: 'shadow', policy: '' });
    await expect(resolveIntegrationToolAutoDecision(call)).resolves.toEqual({
      action: 'shadow',
      mode: 'shadow',
    });
    expect(mockEvaluate).not.toHaveBeenCalled();

    mockSettings.mockResolvedValue({ mode: 'on', policy: 'Reads only.' });
    mockEvaluate.mockResolvedValue(asAnswers(safe));
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({
      action: 'approve',
      mode: 'on',
      evaluation: { recommendation: 'approve' },
    });
    expect(mockEvaluate.mock.calls[0]![0].state.autoPolicy).toBe('Reads only.');

    // Not clearly safe, or no model at all: the card shows.
    mockEvaluate.mockResolvedValue(asAnswers({ ...safe, reachesOutside: 0.7 }));
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({ action: 'ask', mode: 'on' });
    mockEvaluate.mockResolvedValue(null);
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({
      action: 'ask',
      mode: 'on',
      evaluation: { unavailable: 'no_model' },
    });
  });
});
