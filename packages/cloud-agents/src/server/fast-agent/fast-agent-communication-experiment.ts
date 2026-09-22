import { performance } from 'node:perf_hooks';

import type {
  TypeSafeChoiceQuestion,
  TypeSafeNoulQuestion,
} from '../typesafe-judgment';
import { evaluateTypeSafeJudgments } from '../typesafe-judgment';
import type {
  FastAgentReply,
  FastAgentTurnAdapter,
} from './fast-agent-conversation';

const questions = {
  action: {
    type: 'choice',
    instructions:
      'Which bounded orchestration action should the Session take for this task event? Choose report for a new useful milestone, blocker, needed input, or adequately evidenced completion; quiet for routine or redundant progress; inspect, steer, queue, or escalate only when the regular LLM and deterministic policy must retain control.',
    criteria: {
      report: 'Send one useful user-visible closeout or progress report.',
      inspect: 'Inspect task evidence before presenting a conclusion.',
      quiet:
        'Do not send a user-visible message because the report is routine or redundant.',
      steer:
        'Send one corrective instruction to a currently running task; this requires the regular LLM and deterministic authorization checks.',
      queue:
        'Queue or interrupt a changed human instruction; this is deterministic and requires the regular path.',
      escalate:
        'Escalate to the regular LLM because the event needs inspection, complex reasoning, or a policy-sensitive action.',
    },
  } satisfies TypeSafeChoiceQuestion<
    'report' | 'inspect' | 'quiet' | 'steer' | 'queue' | 'escalate'
  >,
  needs_user_input: {
    type: 'noul',
    instructions:
      'Does the task report require a concrete answer or choice from the user before work can continue?',
    criteria: {
      true: 'The task is blocked on user input or a required decision.',
      false: 'The task can continue without user input.',
    },
  } satisfies TypeSafeNoulQuestion,
} as const;

export type FastAgentCommunicationExperimentResult = {
  action:
    | 'report'
    | 'inspect'
    | 'quiet'
    | 'request_input'
    | 'steer'
    | 'queue'
    | 'escalate'
    | 'fallback';
  confidence: number;
  needsUserInputProbability: number;
  fallbackReason?: string;
  modelInferenceMs: number;
  orchestrationMs: number;
  eventToActionMs: number;
  messagePosted: boolean;
};

export async function runJevFastAgentCommunicationExperiment(params: {
  message: string;
  purpose: FastAgentReply['purpose'];
  adapter: FastAgentTurnAdapter;
  taskStatus?: string;
  timeoutMs?: number;
}): Promise<FastAgentCommunicationExperimentResult> {
  const startedAt = performance.now();
  let requestStartedAt: number | undefined;
  let requestCompletedAt: number | undefined;
  const answers = await evaluateTypeSafeJudgments({
    state: {
      session: {
        reportPolicy: 'only_when_notable',
        surface: 'web',
      },
      task: {
        status: params.taskStatus ?? 'reported',
      },
      event: {
        kind: 'child_message',
        purpose: params.purpose,
        text: params.message,
      },
    },
    questions,
    timeoutMs: params.timeoutMs,
    selectionOverride: 'openrouter',
    timing: {
      onRequestStarted: () => {
        requestStartedAt ??= performance.now();
      },
      onRequestCompleted: () => {
        requestCompletedAt ??= performance.now();
      },
    },
  });

  if (!answers) {
    throw new Error('Jev judgment model is not configured.');
  }

  const confidence = answers.action.confidence;
  const needsUserInputProbability = answers.needs_user_input.noul;
  const action =
    answers.action.choice === 'report' && needsUserInputProbability >= 0.75
      ? 'request_input'
      : answers.action.choice;
  const fallbackReason =
    confidence < 0.75
      ? 'low_confidence'
      : answers.action.choice === 'report' &&
          needsUserInputProbability >= 0.5 &&
          needsUserInputProbability < 0.75
        ? 'uncertain_input_need'
        : ['inspect', 'steer', 'queue', 'escalate'].includes(action)
          ? 'regular_llm_required'
          : undefined;

  if (fallbackReason) {
    const actionAt = performance.now();
    const modelInferenceMs =
      requestStartedAt !== undefined && requestCompletedAt !== undefined
        ? requestCompletedAt - requestStartedAt
        : 0;
    return {
      action: 'fallback',
      confidence,
      needsUserInputProbability,
      fallbackReason,
      modelInferenceMs,
      orchestrationMs: Math.max(0, actionAt - startedAt - modelInferenceMs),
      eventToActionMs: actionAt - startedAt,
      messagePosted: false,
    };
  }

  let messagePosted = false;

  if (action === 'report' || action === 'request_input') {
    await params.adapter.postReply({
      purpose: 'closeout',
      message: params.message,
    });
    messagePosted = true;
  }

  const actionAt = performance.now();
  const modelInferenceMs =
    requestStartedAt !== undefined && requestCompletedAt !== undefined
      ? requestCompletedAt - requestStartedAt
      : 0;
  const orchestrationMs = Math.max(0, actionAt - startedAt - modelInferenceMs);

  return {
    action,
    confidence,
    needsUserInputProbability,
    modelInferenceMs,
    orchestrationMs,
    eventToActionMs: actionAt - startedAt,
    messagePosted,
  };
}
