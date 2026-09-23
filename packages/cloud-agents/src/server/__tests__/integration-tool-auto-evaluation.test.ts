const mocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
  resolveModel: vi.fn(async () => ({ kind: 'judgment' }) as unknown),
  record: vi.fn(async () => undefined),
  recordShadow: vi.fn(async () => undefined),
  settings: vi.fn(async () => ({ mode: 'off', policy: '' })),
  experiment: vi.fn(async () => true),
}));

vi.mock('../typesafe-judgment', () => ({
  evaluateDecisionModel: mocks.evaluate,
  resolveDecisionModel: mocks.resolveModel,
}));
vi.mock('@roomote/db/server', async () => ({
  getIntegrationToolAutoSettings: mocks.settings,
  isDeploymentExperimentEnabled: mocks.experiment,
  recordIntegrationToolAutoEvaluation: mocks.record,
  recordIntegrationToolShadowEvaluation: mocks.recordShadow,
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
  recordIntegrationToolShadowEvaluationInBackground,
  resolveIntegrationToolAutoDecision,
  resolveIntegrationToolAutoState,
  RISK_LEVELS,
  type AutoRiskAnswers,
} from '../integration-tool-auto-evaluation';

const routine: AutoRiskAnswers = {
  risk: { score: 0.1, confidence: 0.9 },
  matchesRequest: 0.95,
  steeredByUntrustedContent: 0.02,
};
const modelAnswers = (answers: AutoRiskAnswers) => ({
  risk: { type: 'score', ...answers.risk },
  ...(answers.matchesRequest === undefined
    ? {}
    : { matchesRequest: { type: 'noul', noul: answers.matchesRequest } }),
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
  mocks.settings.mockResolvedValue({ mode: 'off', policy: '' });
  mocks.resolveModel.mockResolvedValue({ kind: 'judgment' });
  mocks.experiment.mockResolvedValue(true);
});

describe('recommendFromAutoAnswers', () => {
  it('runs only a routine call the user asked for; every doubt asks', () => {
    expect(recommendFromAutoAnswers(routine)).toBe('approve');
    // With no request to judge against, the other signals decide.
    expect(
      recommendFromAutoAnswers({ ...routine, matchesRequest: undefined }),
    ).toBe('approve');
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
    mocks.evaluate.mockResolvedValue(modelAnswers(routine));
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
    const { state, questions, userId } = mocks.evaluate.mock.calls[0]![0];
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
    expect(Object.keys(questions).sort()).toEqual([
      'matchesRequest',
      'risk',
      'steeredByUntrustedContent',
    ]);
  });

  it('asks only what there is something to judge against', async () => {
    // No request (a task ask without one) and no guidance: two questions.
    mocks.evaluate.mockResolvedValue(
      modelAnswers({ ...routine, matchesRequest: undefined }),
    );
    const bare = await evaluateIntegrationToolAutoDecision({
      ...call,
      userRequest: undefined,
    });
    expect(bare.answers).not.toHaveProperty('matchesRequest');
    expect(
      Object.keys(mocks.evaluate.mock.calls[0]![0].questions).sort(),
    ).toEqual(['risk', 'steeredByUntrustedContent']);

    // Guidance adds its own question and rides in the state.
    mocks.settings.mockResolvedValue({
      mode: 'on',
      policy: 'Anything sent to customers is high risk.',
    });
    mocks.evaluate.mockResolvedValue(
      modelAnswers({ ...routine, guidanceFlagsRisk: 0.9 }),
    );
    const guided = await evaluateIntegrationToolAutoDecision(call);
    expect(guided).toMatchObject({
      recommendation: 'ask',
      answers: { guidanceFlagsRisk: 0.9 },
    });
    const { state, questions } = mocks.evaluate.mock.calls[1]![0];
    expect(state.deploymentGuidance).toBe(
      'Anything sent to customers is high risk.',
    );
    expect(questions.guidanceFlagsRisk).toBeDefined();
  });

  it('asks when no model or a failed evaluation leaves Auto unable to check', async () => {
    mocks.evaluate.mockResolvedValue(null);
    await expect(
      evaluateIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({
      recommendation: 'ask',
      unavailable: 'no_model',
    });

    mocks.evaluate.mockRejectedValue(new Error('timeout'));
    await expect(
      evaluateIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({ recommendation: 'ask', unavailable: 'error' });
  });
});

describe('resolveIntegrationToolAutoState', () => {
  it('is on with the experiment and the setting, even when no judgment model is left', async () => {
    mocks.settings.mockResolvedValue({ mode: 'on', policy: 'Reads are fine.' });
    await expect(resolveIntegrationToolAutoState()).resolves.toMatchObject({
      mode: 'on',
      model: 'judgment',
      settings: { policy: 'Reads are fine.' },
    });

    // The setting can outlive the model: on stays on so callers ask or deny
    // based on presence instead of silently running unassessed calls. The
    // helper-model fallback is an LLM call per tool call: never implied.
    mocks.resolveModel.mockResolvedValue({ kind: 'helper', model: 'm' });
    await expect(resolveIntegrationToolAutoState()).resolves.toMatchObject({
      mode: 'on',
      model: 'helper',
    });
    mocks.resolveModel.mockResolvedValue(null);
    await expect(resolveIntegrationToolAutoState()).resolves.toMatchObject({
      mode: 'on',
      model: null,
    });

    mocks.resolveModel.mockResolvedValue({ kind: 'judgment' });
    mocks.experiment.mockResolvedValue(false);
    await expect(resolveIntegrationToolAutoState()).resolves.toMatchObject({
      mode: 'off',
    });
    // Auto has an experiment of its own; per-tool approvals do not.
    expect(mocks.experiment).toHaveBeenCalledWith(
      'integrationToolAutoApprovals',
    );
  });

  it('shadows while off with a hosted model, so its judgment can be reviewed', async () => {
    mocks.settings.mockResolvedValue({ mode: 'off', policy: '' });
    await expect(resolveIntegrationToolAutoState()).resolves.toMatchObject({
      mode: 'shadow',
    });
    mocks.resolveModel.mockResolvedValue({ kind: 'helper', model: 'm' });
    await expect(resolveIntegrationToolAutoState()).resolves.toMatchObject({
      mode: 'off',
    });
  });
});

describe('recordIntegrationToolShadowEvaluationInBackground', () => {
  const shadowCall = {
    integrationId: 'linear',
    toolName: 'list_issues',
    args: { team: 'ENG' },
    userId: 'user-1',
    taskId: null,
  };

  it('records an assessment while shadowing and never throws', async () => {
    mocks.evaluate.mockResolvedValue(
      modelAnswers({ ...routine, matchesRequest: undefined }),
    );
    recordIntegrationToolShadowEvaluationInBackground(shadowCall);
    await vi.waitFor(() =>
      expect(mocks.recordShadow).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationId: 'linear',
          toolName: 'list_issues',
          userId: 'user-1',
          evaluation: expect.objectContaining({ recommendation: 'approve' }),
        }),
      ),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.recordShadow.mockRejectedValueOnce(new Error('db down'));
    recordIntegrationToolShadowEvaluationInBackground(shadowCall);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it("asks whether a task's call matches what the user asked for", async () => {
    mocks.evaluate.mockResolvedValue(modelAnswers(routine));
    const resolveUserRequest = vi.fn(async () => 'What is open for ENG?');
    recordIntegrationToolShadowEvaluationInBackground({
      ...shadowCall,
      taskId: 'task-1',
      resolveUserRequest,
    });
    await vi.waitFor(() => expect(mocks.recordShadow).toHaveBeenCalled());
    expect(mocks.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          userRequest: 'What is open for ENG?',
        }),
        questions: expect.objectContaining({
          matchesRequest: expect.anything(),
        }),
      }),
    );

    // A failed lookup still records an assessment, without the request.
    mocks.evaluate.mockClear();
    mocks.recordShadow.mockClear();
    resolveUserRequest.mockRejectedValueOnce(new Error('db down'));
    recordIntegrationToolShadowEvaluationInBackground({
      ...shadowCall,
      taskId: 'task-1',
      resolveUserRequest,
    });
    await vi.waitFor(() => expect(mocks.recordShadow).toHaveBeenCalled());
    expect(mocks.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ userRequest: null }),
      }),
    );
  });

  it('records nothing while Auto is on or fully off', async () => {
    mocks.settings.mockResolvedValue({ mode: 'on', policy: '' });
    recordIntegrationToolShadowEvaluationInBackground(shadowCall);
    mocks.resolveModel.mockResolvedValue(null);
    recordIntegrationToolShadowEvaluationInBackground(shadowCall);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(mocks.recordShadow).not.toHaveBeenCalled();
  });
});

describe('resolveIntegrationToolAutoDecision', () => {
  it('runs unassessed unless on, and then runs only a routine call', async () => {
    await expect(resolveIntegrationToolAutoDecision(call)).resolves.toEqual({
      action: 'run',
      mode: 'off',
    });
    expect(mocks.evaluate).not.toHaveBeenCalled();

    mocks.settings.mockResolvedValue({
      mode: 'on',
      policy: 'Reads are routine.',
    });
    mocks.evaluate.mockResolvedValue(
      modelAnswers({ ...routine, guidanceFlagsRisk: 0.05 }),
    );
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({
      action: 'approve',
      mode: 'on',
      evaluation: { recommendation: 'approve' },
    });
    expect(mocks.evaluate.mock.calls[0]![0].state.deploymentGuidance).toBe(
      'Reads are routine.',
    );

    // Risky, or a failed evaluation: the call asks its owner.
    mocks.evaluate.mockResolvedValue(
      modelAnswers({ ...routine, risk: { score: 2, confidence: 0.9 } }),
    );
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({ action: 'ask', mode: 'on' });
    mocks.evaluate.mockResolvedValue(null);
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({
      action: 'ask',
      mode: 'on',
      evaluation: { unavailable: 'no_model' },
    });
  });

  it('asks when Auto is on but no judgment model is configured', async () => {
    mocks.settings.mockResolvedValue({ mode: 'on', policy: '' });
    mocks.resolveModel.mockResolvedValue(null);
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({
      action: 'ask',
      mode: 'on',
      evaluation: { recommendation: 'ask', unavailable: 'no_model' },
    });
    // The helper model is never used for tool-call assessment.
    mocks.resolveModel.mockResolvedValue({ kind: 'helper', model: 'm' });
    await expect(
      resolveIntegrationToolAutoDecision(call),
    ).resolves.toMatchObject({ action: 'ask', mode: 'on' });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
