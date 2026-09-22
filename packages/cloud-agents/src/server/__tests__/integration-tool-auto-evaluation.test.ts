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
  RISK_LEVELS,
  type AutoRiskAnswers,
} from '../integration-tool-auto-evaluation';

const routine: AutoRiskAnswers = {
  risk: { score: 0.1, confidence: 0.9 },
  matchesRequest: 0.95,
  steeredByUntrustedContent: 0.02,
};
const modelAnswers = (
  answers: AutoRiskAnswers,
): Record<
  string,
  { type: string; noul?: number; score?: number; confidence?: number }
> => ({
  risk: { type: 'score', ...answers.risk },
  matchesRequest: { type: 'noul', noul: answers.matchesRequest },
  steeredByUntrustedContent: {
    type: 'noul',
    noul: answers.steeredByUntrustedContent,
  },
  ...(answers.guidanceFlagsRisk === undefined
    ? {}
    : { guidanceFlagsRisk: { type: 'noul', noul: answers.guidanceFlagsRisk } }),
});
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
  it('runs only a routine call the user asked for; every doubt asks', () => {
    expect(recommendFromAutoAnswers(routine)).toBe('approve');
    for (const doubt of [
      // Anything past "reads and changes nothing", or unsure it is that.
      { risk: { score: 0.8, confidence: 0.9 } },
      { risk: { score: 0.1, confidence: 0.5 } },
      { matchesRequest: 0.6 },
      { steeredByUntrustedContent: 0.4 },
      { guidanceFlagsRisk: 0.5 },
    ] satisfies Partial<AutoRiskAnswers>[]) {
      expect(recommendFromAutoAnswers({ ...routine, ...doubt })).toBe('ask');
    }
  });
});

describe('evaluateIntegrationToolAutoDecision', () => {
  it('asks a risk score over described situations plus the request and injection checks', async () => {
    mockEvaluate.mockResolvedValue(modelAnswers(routine));
    const evaluation = await evaluateIntegrationToolAutoDecision(call);
    expect(evaluation).toMatchObject({
      recommendation: 'approve',
      answers: {
        riskScore: 0.1,
        riskConfidence: 0.9,
        matchesRequest: 0.95,
        steeredByUntrustedContent: 0.02,
      },
    });
    const { state, questions, userId } = mockEvaluate.mock.calls[0]![0];
    expect(userId).toBe('user-1');
    expect(state).toEqual({
      call: {
        integration: 'linear',
        tool: 'list_issues',
        arguments: { team: 'ENG', apiKey: '[redacted]' },
      },
      userRequest: 'What is open for ENG?',
      deploymentGuidance: null,
    });
    expect(questions.risk).toMatchObject({
      type: 'score',
      criteria: RISK_LEVELS,
    });
    expect(Object.keys(questions)).toEqual([
      'risk',
      'matchesRequest',
      'steeredByUntrustedContent',
    ]);
  });

  it('judges the call against the deployment guidance when there is some', async () => {
    mockSettings.mockResolvedValue({
      mode: 'on',
      policy: 'Anything sent to customers is high risk.',
    });
    mockEvaluate.mockResolvedValue(
      modelAnswers({ ...routine, guidanceFlagsRisk: 0.9 }),
    );
    const evaluation = await evaluateIntegrationToolAutoDecision(call);
    expect(evaluation).toMatchObject({
      recommendation: 'ask',
      answers: { guidanceFlagsRisk: 0.9 },
    });
    const { state, questions } = mockEvaluate.mock.calls[0]![0];
    expect(state.deploymentGuidance).toBe(
      'Anything sent to customers is high risk.',
    );
    expect(questions.guidanceFlagsRisk).toBeDefined();
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
    mockEvaluate.mockResolvedValue(
      modelAnswers({ ...routine, risk: { score: 3.2, confidence: 0.8 } }),
    );
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

    mockSettings.mockResolvedValue({
      mode: 'on',
      policy: 'Reads are routine.',
    });
    mockEvaluate.mockResolvedValue(
      modelAnswers({ ...routine, guidanceFlagsRisk: 0.05 }),
    );
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({
      action: 'approve',
      mode: 'on',
      evaluation: { recommendation: 'approve' },
    });
    expect(mockEvaluate.mock.calls[0]![0].state.deploymentGuidance).toBe(
      'Reads are routine.',
    );

    // Risky, or no model at all: the card shows.
    mockEvaluate.mockResolvedValue(
      modelAnswers({ ...routine, risk: { score: 2, confidence: 0.9 } }),
    );
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
