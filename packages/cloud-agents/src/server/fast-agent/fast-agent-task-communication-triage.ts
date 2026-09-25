import { performance } from 'node:perf_hooks';

import { captureEvent } from '@roomote/telemetry/server';

import {
  evaluateTypeSafeJudgments,
  type TypeSafeNoulQuestion,
} from '../typesafe-judgment';
import type { FastAgentSurface } from './fast-agent-conversation';

/**
 * How long the person who asked for the work has gone without hearing from
 * the Session. Measured by code from the transcript, never estimated by a
 * model.
 */
export type TaskCommunicationSilence =
  | 'never_heard'
  | 'under_5_minutes'
  | '5_to_20_minutes'
  | 'over_20_minutes';

export type TaskCommunicationUpdate =
  | {
      kind: 'task_report';
      purpose: 'ack' | 'progress' | 'closeout' | 'clarification';
      text: string;
    }
  | {
      kind: 'task_activity';
      items: Array<{
        kind: 'assistant_message' | 'plan' | 'question' | 'tools';
        text: string;
      }>;
    };

export type TaskCommunicationTriageState = {
  surface: FastAgentSurface;
  /** The requester has the Session open, or spoke in it moments ago. */
  requesterIsPresent: boolean;
  silenceSinceRequesterLastHeard: TaskCommunicationSilence;
  /** Oldest first: the task's instructions, then what people said after. */
  whatTheRequesterAskedFor: string[];
  /** Most recent last: what the Session already told people. */
  whatTheRequesterWasAlreadyTold: string[];
  task: { title: string | null };
  update: TaskCommunicationUpdate;
};

export const TASK_COMMUNICATION_QUESTIONS = {
  needs_user: {
    type: 'noul',
    instructions:
      'Is the task blocked on something only the requester can provide right now, such as a decision between options, missing access or credentials, or an answer to a direct question?',
    criteria: {
      true: 'The task cannot sensibly continue until the requester answers or acts.',
      false:
        'The task can keep going on its own, or any question in the update is rhetorical, already answered, or one the task can resolve itself.',
    },
  },
  changes_picture: {
    type: 'noul',
    instructions:
      'Has the task found that the request rests on a wrong or incomplete premise? For example: the reported problem comes from behavior that exists on purpose (a feature working as designed) or has a different cause or trigger than described, the thing the requester wants changed does not exist, or the requested approach will not work as asked.',
    criteria: {
      true: 'The task learned something that contradicts or corrects what the requester believed when they asked.',
      false:
        'What the task found matches what the requester described; it is only filling in details.',
    },
  },
  judgment_call: {
    type: 'noul',
    instructions:
      'Is the task making, or about to make, a consequential choice the requester did not specify and could reasonably disagree with? For example: fixing a reported problem by changing or disabling behavior that exists on purpose, building something substantial they did not ask for, removing something, or satisfying a stated constraint through a non-obvious workaround.',
    criteria: {
      true: 'The requester would likely want a say before this choice lands.',
      false:
        'The choices are routine implementation details, or the requester explicitly asked for them.',
    },
  },
  actionable_milestone: {
    type: 'noul',
    instructions:
      'Does the update contain something concrete the requester can look at, try, or act on now, such as an opened pull request, a working preview, a confirmed reproduction, or a finished answer to their question?',
    criteria: {
      true: 'There is a concrete result the requester could use or review now.',
      false:
        'Nothing in the update is ready for the requester to use or review yet.',
    },
  },
  off_track: {
    type: 'noul',
    instructions:
      'Is the task working against what the requester wants, taking into account everything they said after the task started? Consider changing things they said not to touch, solving a different problem, ignoring a stated constraint, or continuing work they called off.',
    criteria: {
      true: 'The task is heading somewhere the requester did not ask for or explicitly ruled out, and should be steered.',
      false:
        'The task is doing what the requester asked, even if slowly or by a route they did not specify.',
    },
  },
  already_told: {
    type: 'noul',
    instructions:
      'Does the requester effectively already know everything useful in this update from what the Session already told them?',
    criteria: {
      true: 'The update repeats what the requester was already told, in substance.',
      false:
        'The update contains something useful the requester has not heard.',
    },
  },
} as const satisfies Record<string, TypeSafeNoulQuestion>;

export type TaskCommunicationSignal = keyof typeof TASK_COMMUNICATION_QUESTIONS;

export type TaskCommunicationSignals = Record<TaskCommunicationSignal, number>;

export type TaskCommunicationDecision =
  | 'relay'
  | 'redirect'
  | 'quiet'
  | 'uncertain';

export type TaskCommunicationDecisionReason =
  | 'off_track'
  | 'needs_user'
  | 'changes_picture'
  | 'judgment_call'
  | 'actionable_milestone'
  | 'already_told'
  | 'task_result'
  | 'task_question'
  | 'milestone_can_wait'
  | 'routine'
  | 'mixed_signals';

export type TaskCommunicationTriageResult = {
  decision: TaskCommunicationDecision;
  reason: TaskCommunicationDecisionReason;
  signals: TaskCommunicationSignals;
  latencyMs: number;
};

/**
 * Per-signal level at which a signal counts as clearly true. The judgment
 * model compresses these probabilities differently per question, so each was
 * set by replaying real task updates: routine updates never scored
 * `changes_picture` above ~0.2 or `judgment_call` above ~0.3, while the
 * moments worth hearing about scored 0.4 and up.
 */
export const TASK_COMMUNICATION_SIGNAL_THRESHOLDS: TaskCommunicationSignals = {
  needs_user: 0.7,
  changes_picture: 0.35,
  judgment_call: 0.5,
  actionable_milestone: 0.7,
  off_track: 0.7,
  already_told: 0.7,
};
/** Below this share of its threshold, a signal is clearly false. */
const ROUTINE_SHARE_OF_THRESHOLD = 0.75;

/**
 * Deterministic policy over the judgment signals. Steering wins because a
 * task heading the wrong way wastes work every minute; the user hears about
 * it from the steering turn itself. A milestone can wait for the closeout
 * unless the requester is watching or has not heard anything in a while.
 */
export function decideTaskCommunication(
  signals: TaskCommunicationSignals,
  context: Pick<
    TaskCommunicationTriageState,
    'requesterIsPresent' | 'silenceSinceRequesterLastHeard' | 'update'
  >,
): {
  decision: TaskCommunicationDecision;
  reason: TaskCommunicationDecisionReason;
} {
  const high = (signal: TaskCommunicationSignal) =>
    signals[signal] >= TASK_COMMUNICATION_SIGNAL_THRESHOLDS[signal];

  if (high('off_track')) {
    return { decision: 'redirect', reason: 'off_track' };
  }
  if (high('already_told')) {
    return { decision: 'quiet', reason: 'already_told' };
  }
  // The task's own result or question is what the user is waiting for; it
  // is never deferred or dropped on the strength of a low score.
  if (context.update.kind === 'task_report') {
    if (context.update.purpose === 'closeout') {
      return { decision: 'relay', reason: 'task_result' };
    }
    if (context.update.purpose === 'clarification') {
      return { decision: 'relay', reason: 'task_question' };
    }
  }
  if (high('needs_user')) {
    return { decision: 'relay', reason: 'needs_user' };
  }
  if (high('changes_picture')) {
    return { decision: 'relay', reason: 'changes_picture' };
  }
  if (high('judgment_call')) {
    return { decision: 'relay', reason: 'judgment_call' };
  }
  if (high('actionable_milestone')) {
    const worthInterrupting =
      context.requesterIsPresent ||
      context.silenceSinceRequesterLastHeard === '5_to_20_minutes' ||
      context.silenceSinceRequesterLastHeard === 'over_20_minutes';
    return worthInterrupting
      ? { decision: 'relay', reason: 'actionable_milestone' }
      : { decision: 'quiet', reason: 'milestone_can_wait' };
  }
  const actionSignals: TaskCommunicationSignal[] = [
    'off_track',
    'needs_user',
    'changes_picture',
    'judgment_call',
    'actionable_milestone',
  ];
  if (
    actionSignals.every(
      (signal) =>
        signals[signal] <
        TASK_COMMUNICATION_SIGNAL_THRESHOLDS[signal] *
          ROUTINE_SHARE_OF_THRESHOLD,
    )
  ) {
    return { decision: 'quiet', reason: 'routine' };
  }
  return { decision: 'uncertain', reason: 'mixed_signals' };
}

/**
 * Ask the judgment model whether a delegated task's update matters to the
 * person who asked for the work. Returns `null` when no judgment model is
 * configured; throws on provider failure so callers can fall back.
 */
export async function triageTaskCommunication(
  state: TaskCommunicationTriageState,
  options: { timeoutMs?: number } = {},
): Promise<TaskCommunicationTriageResult | null> {
  const startedAt = performance.now();
  const answers = await evaluateTypeSafeJudgments({
    state,
    questions: TASK_COMMUNICATION_QUESTIONS,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (!answers) {
    return null;
  }

  const signals: TaskCommunicationSignals = {
    needs_user: answers.needs_user.noul,
    changes_picture: answers.changes_picture.noul,
    judgment_call: answers.judgment_call.noul,
    actionable_milestone: answers.actionable_milestone.noul,
    off_track: answers.off_track.noul,
    already_told: answers.already_told.noul,
  };
  return {
    ...decideTaskCommunication(signals, state),
    signals,
    latencyMs: performance.now() - startedAt,
  };
}

export function captureTaskCommunicationTriage(input: {
  userId: string;
  sessionId: string;
  eventType: 'child_message' | 'task_activity';
  surface: FastAgentSurface;
  outcome:
    | TaskCommunicationDecision
    | 'rate_limited'
    | 'judgment_unconfigured'
    | 'judgment_failed';
  reason?: TaskCommunicationDecisionReason;
  signals?: TaskCommunicationSignals;
  latencyMs?: number;
}): void {
  void captureEvent('session_task_communication_triaged', {
    userId: input.userId,
    properties: {
      session_id: input.sessionId,
      event_type: input.eventType,
      surface: input.surface,
      outcome: input.outcome,
      reason: input.reason ?? null,
      latency_ms:
        input.latencyMs === undefined ? null : Math.round(input.latencyMs),
      ...(input.signals
        ? Object.fromEntries(
            Object.entries(input.signals).map(([signal, probability]) => [
              `p_${signal}`,
              Math.round(probability * 1000) / 1000,
            ]),
          )
        : {}),
    },
  });
}

/** What the parent model is told about a triaged task update. */
export type TaskCommunicationTriageHint = {
  decision: Exclude<TaskCommunicationDecision, 'quiet'>;
  reason: TaskCommunicationDecisionReason;
};
