import {
  COMMUNICATION_SCENARIOS,
  resolveModelCommunicationAction,
  runCommunicationTrial,
  summarizeCommunicationTrials,
  type CommunicationDecisionAdapter,
} from '../session-communication-latency-experiment';

describe('session communication latency experiment', () => {
  it('covers the required decision cases and expected actions', () => {
    expect(COMMUNICATION_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'important_milestone',
      'blocked_user_input',
      'routine_redundant_progress',
      'completion_adequate_evidence',
      'completion_missing_evidence',
      'explicit_user_steering',
    ]);
    expect(
      COMMUNICATION_SCENARIOS.map((scenario) => scenario.expectedAction),
    ).toEqual([
      'report',
      'request_input',
      'quiet',
      'report',
      'inspect',
      'steer',
    ]);
  });

  it('uses the deterministic input threshold after one model decision', () => {
    expect(
      resolveModelCommunicationAction({
        action: 'report',
        needsUserInputProbability: 0.5,
      }),
    ).toBe('request_input');
    expect(
      resolveModelCommunicationAction({
        action: 'report',
        needsUserInputProbability: 0.49,
      }),
    ).toBe('report');
  });

  it('forwards explicit user steering without invoking the adapter', async () => {
    const adapter: CommunicationDecisionAdapter = {
      name: 'jev',
      decide: vi.fn(),
    };
    const nowValues = [0, 0.2, 0.3, 1.1];
    const result = await runCommunicationTrial({
      scenario: COMMUNICATION_SCENARIOS.find(
        (scenario) => scenario.id === 'explicit_user_steering',
      )!,
      adapter,
      now: () => nowValues.shift() ?? 1.1,
    });

    expect(adapter.decide).not.toHaveBeenCalled();
    expect(result.actualAction).toBe('steer');
    expect(result.correct).toBe(true);
    expect(result.deterministicForwarding).toBe(true);
    expect(result.modelInvoked).toBe(false);
    expect(result.durationsMs.inference).toBeNull();
  });

  it('records inference and orchestration timing separately', async () => {
    const adapter: CommunicationDecisionAdapter = {
      name: 'regular-llm',
      decide: async (_scenario, timing) => {
        timing.markInferenceStarted();
        timing.markInferenceCompleted();
        return { action: 'quiet', needsUserInputProbability: 0 };
      },
    };
    let current = 0;
    const result = await runCommunicationTrial({
      scenario: COMMUNICATION_SCENARIOS.find(
        (scenario) => scenario.id === 'routine_redundant_progress',
      )!,
      adapter,
      now: () => {
        current += 1;
        return current;
      },
    });

    expect(result.status).toBe('completed');
    expect(result.correct).toBe(true);
    expect(result.durationsMs.inference).toBe(1);
    expect(result.durationsMs.orchestration).toBe(2);
    expect(result.durationsMs.eventToAction).toBe(5);
  });

  it('summarizes latency percentiles and correctness by scenario', async () => {
    const scenario = COMMUNICATION_SCENARIOS.find(
      (entry) => entry.id === 'important_milestone',
    )!;
    const adapter: CommunicationDecisionAdapter = {
      name: 'jev',
      decide: async (_scenario, timing) => {
        timing.markInferenceStarted();
        timing.markInferenceCompleted();
        return { action: 'report', needsUserInputProbability: 0 };
      },
    };
    const trials = await Promise.all(
      [1, 2, 3].map(() => runCommunicationTrial({ scenario, adapter })),
    );
    const summary = summarizeCommunicationTrials('jev', trials);

    expect(summary.sampleCount).toBe(3);
    expect(summary.completedCount).toBe(3);
    expect(summary.correctCount).toBe(3);
    expect(summary.accuracy).toBe(1);
    expect(summary.scenarios.important_milestone!.actions.report).toBe(3);
    expect(summary.latencyMs.eventToAction.p50).not.toBeNull();
    expect(summary.latencyMs.eventToAction.p95).not.toBeNull();
  });
});
