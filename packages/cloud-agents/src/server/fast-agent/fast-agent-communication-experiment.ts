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
      'Which communication action should the Session take for this task report? Choose report for a new useful milestone, blocker, needed input, or adequately evidenced completion; choose inspect when evidence is insufficient; choose quiet for routine or redundant progress.',
    criteria: {
      report: 'Send one useful user-visible closeout or progress report.',
      inspect: 'Inspect task evidence before presenting a conclusion.',
      quiet:
        'Do not send a user-visible message because the report is routine or redundant.',
    },
  } satisfies TypeSafeChoiceQuestion<'report' | 'inspect' | 'quiet'>,
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
  action: 'report' | 'inspect' | 'quiet' | 'request_input';
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

  const action =
    answers.action.choice === 'report' && answers.needs_user_input.noul >= 0.5
      ? 'request_input'
      : answers.action.choice;
  let messagePosted = false;

  if (action === 'report' || action === 'request_input') {
    await params.adapter.postReply({
      purpose: 'closeout',
      message: params.message,
    });
    messagePosted = true;
  } else if (action === 'inspect') {
    await params.adapter.postReply({
      purpose: 'closeout',
      message:
        'I need to inspect the task evidence before presenting a completion update.',
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
    modelInferenceMs,
    orchestrationMs,
    eventToActionMs: actionAt - startedAt,
    messagePosted,
  };
}
