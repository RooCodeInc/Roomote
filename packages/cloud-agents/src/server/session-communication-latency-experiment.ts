import { performance } from 'node:perf_hooks';

const MODEL_DECISION_ACTIONS = ['report', 'inspect', 'quiet'] as const;

export type ModelDecisionAction = (typeof MODEL_DECISION_ACTIONS)[number];
export type ExpectedCommunicationAction =
  | ModelDecisionAction
  | 'request_input'
  | 'steer';

export type CommunicationScenario = (typeof COMMUNICATION_SCENARIOS)[number];

export type ModelCommunicationDecision = {
  action: ModelDecisionAction;
  needsUserInputProbability: number;
  actionProbabilities?: Readonly<Record<ModelDecisionAction, number>>;
  actionConfidence?: number;
};

export type DecisionTimingHooks = {
  markInferenceStarted: () => void;
  markInferenceCompleted: () => void;
};

export type CommunicationDecisionAdapter = {
  name: 'regular-llm' | 'jev';
  decide: (
    scenario: CommunicationScenario,
    timing: DecisionTimingHooks,
  ) => Promise<ModelCommunicationDecision>;
};

export type CommunicationTrialResult = {
  mechanism: CommunicationDecisionAdapter['name'];
  scenarioId: CommunicationScenario['id'];
  expectedAction: ExpectedCommunicationAction;
  actualAction?: ExpectedCommunicationAction;
  status: 'completed' | 'error';
  correct: boolean | null;
  deterministicForwarding: boolean;
  modelInvoked: boolean;
  errorCategory?: string;
  decision?: ModelCommunicationDecision;
  timelineMs: {
    eventEmitted: number;
    eventObservable: number;
    decisionStarted: number;
    inferenceStarted: number | null;
    inferenceCompleted: number | null;
    decisionCompleted: number;
    actionEmitted: number | null;
  };
  durationsMs: {
    preInference: number | null;
    inference: number | null;
    postInference: number | null;
    orchestration: number;
    decision: number;
    eventToAction: number | null;
  };
};

type LatencyAggregate = {
  count: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
};

type CommunicationAggregate = {
  mechanism: CommunicationDecisionAdapter['name'];
  sampleCount: number;
  completedCount: number;
  errorCount: number;
  deterministicForwardingCount: number;
  correctCount: number;
  accuracy: number | null;
  latencyMs: {
    eventToAction: LatencyAggregate;
    inference: LatencyAggregate;
    orchestration: LatencyAggregate;
  };
  scenarios: Record<
    string,
    {
      expectedAction: ExpectedCommunicationAction;
      sampleCount: number;
      completedCount: number;
      errorCount: number;
      correctCount: number;
      accuracy: number | null;
      actions: Record<string, number>;
    }
  >;
};

export const COMMUNICATION_SCENARIOS = [
  {
    id: 'important_milestone',
    title: 'Important milestone worth reporting immediately',
    kind: 'task_event',
    expectedAction: 'report',
    state: {
      session: {
        reportPolicy: 'only_when_notable',
        lastVisibleUpdate:
          'The task started implementing the requested change.',
      },
      task: {
        status: 'running',
        goal: 'Implement the requested repository change and validate it.',
        evidence: [
          'The targeted test suite passed.',
          'The requested artifact was written.',
        ],
      },
      event: {
        kind: 'child_message',
        purpose: 'progress',
        text: 'Milestone: the implementation and targeted tests are complete; the requested artifact is ready for review.',
      },
    },
  },
  {
    id: 'blocked_user_input',
    title: 'Task is blocked and needs user input',
    kind: 'task_event',
    expectedAction: 'request_input',
    state: {
      session: {
        reportPolicy: 'only_when_notable',
        lastVisibleUpdate: 'The task is preparing the deployment validation.',
      },
      task: {
        status: 'waiting_for_input',
        goal: 'Run the deployment validation against the selected environment.',
        evidence: [
          'The environment is reachable.',
          'A required deployment choice is missing.',
        ],
      },
      event: {
        kind: 'child_message',
        purpose: 'clarification',
        text: 'Blocked: validation needs the deployment target choice before it can continue. Please choose staging or production.',
      },
    },
  },
  {
    id: 'routine_redundant_progress',
    title: 'Routine redundant progress should stay quiet',
    kind: 'task_event',
    expectedAction: 'quiet',
    state: {
      session: {
        reportPolicy: 'only_when_notable',
        lastVisibleUpdate: 'The task is formatting the remaining files.',
      },
      task: {
        status: 'running',
        goal: 'Apply the requested formatting and run the existing checks.',
        evidence: [
          'No user-visible outcome changed.',
          'No blocker or new decision is present.',
        ],
      },
      event: {
        kind: 'child_message',
        purpose: 'progress',
        text: 'Progress: formatted another batch of files; the checks and outcome are unchanged.',
      },
    },
  },
  {
    id: 'completion_adequate_evidence',
    title: 'Completion has adequate evidence',
    kind: 'task_event',
    expectedAction: 'report',
    state: {
      session: {
        reportPolicy: 'only_when_notable',
        lastVisibleUpdate: 'The task was running its final validation.',
      },
      task: {
        status: 'completed',
        goal: 'Implement the requested repository change and validate it.',
        evidence: [
          'The changed files are listed in the report.',
          'The focused tests and typecheck passed.',
          'A draft pull request was created for review.',
        ],
      },
      event: {
        kind: 'task_settled',
        purpose: 'closeout',
        text: 'Completed: the requested change is implemented, focused tests and typecheck passed, and the draft pull request is ready for review.',
      },
    },
  },
  {
    id: 'completion_missing_evidence',
    title: 'Completion claim lacks enough evidence and needs inspection',
    kind: 'task_event',
    expectedAction: 'inspect',
    state: {
      session: {
        reportPolicy: 'only_when_notable',
        lastVisibleUpdate:
          'The task was expected to provide a validated result.',
      },
      task: {
        status: 'completed',
        goal: 'Implement the requested repository change and validate it.',
        evidence: [],
      },
      event: {
        kind: 'task_settled',
        purpose: 'closeout',
        text: 'Completed successfully.',
      },
    },
  },
  {
    id: 'explicit_user_steering',
    title: 'Active task receives explicit user steering',
    kind: 'user_steering',
    expectedAction: 'steer',
    state: {
      session: {
        reportPolicy: 'only_when_notable',
        lastVisibleUpdate: 'The task is actively running the worker tests.',
      },
      task: {
        status: 'running',
        goal: 'Investigate the worker test failure and prepare a fix.',
        evidence: ['The task is still executing.'],
      },
      event: {
        kind: 'human_message',
        text: 'Please prioritize the failing worker test, keep the scope to that regression, and report the result when the focused check is complete.',
      },
    },
  },
] as const;

export function resolveModelCommunicationAction(
  decision: ModelCommunicationDecision,
): ModelDecisionAction | 'request_input' {
  return decision.action === 'report' &&
    decision.needsUserInputProbability >= 0.5
    ? 'request_input'
    : decision.action;
}

function classifyExperimentError(error: unknown): string {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();

  if (message.includes('401') || message.includes('unauthorized')) {
    return 'invalid_credentials';
  }
  if (message.includes('429') || message.includes('rate limit')) {
    return 'rate_limited';
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  if (
    message.includes('model configuration is required') ||
    message.includes('not configured')
  ) {
    return 'model_unconfigured';
  }
  if (message.includes('http 4') || message.includes('http 5')) {
    return 'provider_http_error';
  }
  return 'provider_or_harness_error';
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

export async function runCommunicationTrial(params: {
  scenario: CommunicationScenario;
  adapter: CommunicationDecisionAdapter;
  now?: () => number;
}): Promise<CommunicationTrialResult> {
  const now = params.now ?? (() => performance.now());
  const eventEmittedAt = now();
  const eventObservableAt = now();
  const decisionStartedAt = now();
  let inferenceStartedAt: number | undefined;
  let inferenceCompletedAt: number | undefined;
  let decisionCompletedAt = decisionStartedAt;

  const timing: DecisionTimingHooks = {
    markInferenceStarted: () => {
      inferenceStartedAt ??= now();
    },
    markInferenceCompleted: () => {
      inferenceCompletedAt ??= now();
    },
  };

  if (params.scenario.kind === 'user_steering') {
    const actionEmittedAt = now();
    decisionCompletedAt = actionEmittedAt;
    return buildTrialResult({
      mechanism: params.adapter.name,
      scenario: params.scenario,
      actualAction: 'steer',
      deterministicForwarding: true,
      modelInvoked: false,
      eventEmittedAt,
      eventObservableAt,
      decisionStartedAt,
      decisionCompletedAt,
      actionEmittedAt,
      inferenceStartedAt,
      inferenceCompletedAt,
    });
  }

  try {
    const decision = await params.adapter.decide(params.scenario, timing);
    decisionCompletedAt = now();
    const actionEmittedAt = now();
    return buildTrialResult({
      mechanism: params.adapter.name,
      scenario: params.scenario,
      decision,
      actualAction: resolveModelCommunicationAction(decision),
      deterministicForwarding: false,
      modelInvoked: true,
      eventEmittedAt,
      eventObservableAt,
      decisionStartedAt,
      decisionCompletedAt,
      actionEmittedAt,
      inferenceStartedAt,
      inferenceCompletedAt,
    });
  } catch (error) {
    decisionCompletedAt = now();
    return buildTrialResult({
      mechanism: params.adapter.name,
      scenario: params.scenario,
      deterministicForwarding: false,
      modelInvoked: true,
      errorCategory: classifyExperimentError(error),
      eventEmittedAt,
      eventObservableAt,
      decisionStartedAt,
      decisionCompletedAt,
      actionEmittedAt: undefined,
      inferenceStartedAt,
      inferenceCompletedAt,
    });
  }
}

function buildTrialResult(params: {
  mechanism: CommunicationDecisionAdapter['name'];
  scenario: CommunicationScenario;
  decision?: ModelCommunicationDecision;
  actualAction?: ExpectedCommunicationAction;
  deterministicForwarding: boolean;
  modelInvoked: boolean;
  errorCategory?: string;
  eventEmittedAt: number;
  eventObservableAt: number;
  decisionStartedAt: number;
  inferenceStartedAt?: number;
  inferenceCompletedAt?: number;
  decisionCompletedAt: number;
  actionEmittedAt?: number;
}): CommunicationTrialResult {
  const inference =
    params.inferenceStartedAt !== undefined &&
    params.inferenceCompletedAt !== undefined
      ? Math.max(0, params.inferenceCompletedAt - params.inferenceStartedAt)
      : null;
  const preInference =
    params.inferenceStartedAt === undefined
      ? null
      : Math.max(0, params.inferenceStartedAt - params.decisionStartedAt);
  const postInference =
    params.inferenceCompletedAt === undefined
      ? null
      : Math.max(0, params.decisionCompletedAt - params.inferenceCompletedAt);
  const decision = Math.max(
    0,
    params.decisionCompletedAt - params.decisionStartedAt,
  );
  const orchestration =
    inference === null ? decision : Math.max(0, decision - inference);
  const eventToAction =
    params.actionEmittedAt === undefined
      ? null
      : Math.max(0, params.actionEmittedAt - params.eventObservableAt);
  const actualAction = params.actualAction;

  return {
    mechanism: params.mechanism,
    scenarioId: params.scenario.id,
    expectedAction: params.scenario.expectedAction,
    ...(actualAction ? { actualAction } : {}),
    status: params.errorCategory ? 'error' : 'completed',
    correct:
      actualAction === undefined
        ? null
        : actualAction === params.scenario.expectedAction,
    deterministicForwarding: params.deterministicForwarding,
    modelInvoked: params.modelInvoked,
    ...(params.errorCategory ? { errorCategory: params.errorCategory } : {}),
    ...(params.decision ? { decision: params.decision } : {}),
    timelineMs: {
      eventEmitted: 0,
      eventObservable: rounded(
        params.eventObservableAt - params.eventEmittedAt,
      ),
      decisionStarted: rounded(
        params.decisionStartedAt - params.eventEmittedAt,
      ),
      inferenceStarted:
        params.inferenceStartedAt === undefined
          ? null
          : rounded(params.inferenceStartedAt - params.eventEmittedAt),
      inferenceCompleted:
        params.inferenceCompletedAt === undefined
          ? null
          : rounded(params.inferenceCompletedAt - params.eventEmittedAt),
      decisionCompleted: rounded(
        params.decisionCompletedAt - params.eventEmittedAt,
      ),
      actionEmitted:
        params.actionEmittedAt === undefined
          ? null
          : rounded(params.actionEmittedAt - params.eventEmittedAt),
    },
    durationsMs: {
      preInference: preInference === null ? null : rounded(preInference),
      inference: inference === null ? null : rounded(inference),
      postInference: postInference === null ? null : rounded(postInference),
      orchestration: rounded(orchestration),
      decision: rounded(decision),
      eventToAction: eventToAction === null ? null : rounded(eventToAction),
    },
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return rounded(sorted[lower]!);
  const weight = position - lower;
  return rounded(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * weight);
}

function aggregateLatency(values: number[]): LatencyAggregate {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: values.length > 0 ? rounded(Math.min(...values)) : null,
    max: values.length > 0 ? rounded(Math.max(...values)) : null,
  };
}

function numericValues(
  trials: CommunicationTrialResult[],
  selector: (trial: CommunicationTrialResult) => number | null,
): number[] {
  return trials
    .map(selector)
    .filter((value): value is number => typeof value === 'number');
}

export function summarizeCommunicationTrials(
  mechanism: CommunicationDecisionAdapter['name'],
  trials: CommunicationTrialResult[],
): CommunicationAggregate {
  const completed = trials.filter((trial) => trial.status === 'completed');
  const latencyTrials = completed.filter(
    (trial) => !trial.deterministicForwarding,
  );
  const correct = completed.filter((trial) => trial.correct === true).length;
  const scenarios = Object.fromEntries(
    COMMUNICATION_SCENARIOS.map((scenario) => {
      const selected = trials.filter(
        (trial) => trial.scenarioId === scenario.id,
      );
      const selectedCompleted = selected.filter(
        (trial) => trial.status === 'completed',
      );
      const selectedCorrect = selectedCompleted.filter(
        (trial) => trial.correct === true,
      ).length;
      const actions = selectedCompleted.reduce(
        (counts, trial) => {
          if (trial.actualAction) {
            counts[trial.actualAction] = (counts[trial.actualAction] ?? 0) + 1;
          }
          return counts;
        },
        {} as Record<string, number>,
      );

      return [
        scenario.id,
        {
          expectedAction: scenario.expectedAction,
          sampleCount: selected.length,
          completedCount: selectedCompleted.length,
          errorCount: selected.length - selectedCompleted.length,
          correctCount: selectedCorrect,
          accuracy:
            selectedCompleted.length > 0
              ? rounded(selectedCorrect / selectedCompleted.length)
              : null,
          actions,
        },
      ];
    }),
  );

  return {
    mechanism,
    sampleCount: trials.length,
    completedCount: completed.length,
    errorCount: trials.length - completed.length,
    deterministicForwardingCount: completed.filter(
      (trial) => trial.deterministicForwarding,
    ).length,
    correctCount: correct,
    accuracy: completed.length > 0 ? rounded(correct / completed.length) : null,
    latencyMs: {
      eventToAction: aggregateLatency(
        numericValues(
          latencyTrials,
          (trial) => trial.durationsMs.eventToAction,
        ),
      ),
      inference: aggregateLatency(
        numericValues(latencyTrials, (trial) => trial.durationsMs.inference),
      ),
      orchestration: aggregateLatency(
        numericValues(
          latencyTrials,
          (trial) => trial.durationsMs.orchestration,
        ),
      ),
    },
    scenarios,
  };
}
