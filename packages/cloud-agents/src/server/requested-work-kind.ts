import { z } from 'zod';

import {
  type RequestedWorkKind,
  type RequestedWorkKindDecision,
  type TaskToolActionId,
  requestedWorkKindSchema,
} from '@roomote/types';

import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from './non-task-provider-usage';
import {
  evaluateTypeSafeJudgments,
  type TypeSafeChoiceQuestion,
} from './typesafe-judgment';

type ExplicitBootstrapSkill = 'explain-repo-code' | 'plan-repo-implementation';

const requestedWorkKindClassifierResponseSchema = z.object({
  kind: requestedWorkKindSchema,
  confidence: z.number().nullable().optional(),
});

function normalizeConfidence(
  confidence: number | null | undefined,
): number | null {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return null;
  }

  if (confidence < 0 || confidence > 1) {
    return null;
  }

  return confidence;
}

const REQUESTED_WORK_KIND_PROMPT = `
You classify the initial requested work kind for a Roomote task.

Return exactly one kind:
- question: explanation, understanding, investigation, diagnosis, review, or connected-system action asks that do not require repository or workspace changes
- plan: planning, scoping, design, sequencing, or proposal asks that should remain non-mutating
- implement: asks to build, fix, change, create, edit, write, run, or otherwise execute repository or workspace work
- unknown: the ask is still too conflicting or underspecified to choose even after applying the ambiguity rule below

Classify the user's initial ask only. Do not infer later lifecycle behavior.
When the ask is mixed or ambiguous, use implementation straightforwardness as the tiebreaker:
- choose implement when any part of the request asks to modify repository or workspace state, run commands in the repository or workspace, validate changes, or deliver code, even when another part asks for external investigation
- choose implement when the likely repository or workspace implementation path is narrow, conventional, and low-decision
- choose plan when the work likely requires meaningful product, scope, or architecture decisions before implementation
- choose unknown only when the request remains too contradictory or underspecified to judge that tiebreaker reliably
Examples:
- "Check Better Stack and fix the failure" is implement
- "Inspect Sentry, then patch the crash" is implement
- "Check Better Stack and tell me what failed" is question
- "Run a Sentry query and report the results" is question
Confidence should be a number from 0 to 1 when you can estimate it.
`.trim();

const REQUESTED_WORK_KIND_TIMEOUT_MS = 5_000;

/**
 * Below this Choice confidence the judgment model's answer is discarded and
 * the helper model classifies instead. Starting value, not tuned.
 */
const JUDGMENT_MIN_CONFIDENCE = 0.5;

const REQUESTED_WORK_KIND_QUESTION: TypeSafeChoiceQuestion<RequestedWorkKind> =
  {
    type: 'choice',
    instructions:
      "What kind of work does the user's initial ask in `prompt` request from a coding agent? Classify the initial ask only, not later lifecycle behavior. When the ask mixes investigation with changes, any request to modify, run, validate, or deliver repository or workspace work makes it implement.",
    criteria: {
      question:
        'Explanation, understanding, investigation, diagnosis, review, or a connected-system action that needs no repository or workspace changes. Examples: "Check Better Stack and tell me what failed", "Run a Sentry query and report the results".',
      plan: 'Planning, scoping, design, sequencing, or a proposal that should stay non-mutating, including work that needs meaningful product, scope, or architecture decisions before implementation.',
      implement:
        'Build, fix, change, create, edit, write, run, or otherwise execute repository or workspace work, including narrow, conventional, low-decision changes. Examples: "Check Better Stack and fix the failure", "Inspect Sentry, then patch the crash".',
      unknown:
        'Too contradictory or underspecified to pick any of the other kinds.',
    },
  };

const EXPLICIT_BOOTSTRAP_KIND: Record<
  ExplicitBootstrapSkill,
  Extract<RequestedWorkKind, 'question' | 'plan'>
> = {
  'explain-repo-code': 'question',
  'plan-repo-implementation': 'plan',
};

const TASK_TOOL_KIND: Record<TaskToolActionId, RequestedWorkKind> = {
  simplify: 'implement',
  push: 'implement',
  'create-draft-pr': 'implement',
  'create-pr': 'implement',
  'review-code': 'question',
  'review-and-fix': 'implement',
  'address-pr-feedback': 'implement',
  'capture-visual-proof': 'implement',
};

function getExplicitBootstrapRequestedWorkKindDecision(
  skill?: ExplicitBootstrapSkill | null,
): RequestedWorkKindDecision | undefined {
  if (!skill) {
    return undefined;
  }

  return {
    kind: EXPLICIT_BOOTSTRAP_KIND[skill],
    source: 'explicit_bootstrap',
    confidence: 1,
  };
}

function getTaskToolRequestedWorkKindDecision(
  actionId?: TaskToolActionId | null,
): RequestedWorkKindDecision | undefined {
  if (!actionId) {
    return undefined;
  }

  return {
    kind: TASK_TOOL_KIND[actionId],
    source: 'task_tool',
    confidence: 1,
  };
}

function getInheritedRequestedWorkKindDecision(
  kind?: RequestedWorkKind | null,
): RequestedWorkKindDecision | undefined {
  if (!kind) {
    return undefined;
  }

  return {
    kind,
    source: 'inherited',
    confidence: null,
  };
}

function getSystemDefaultRequestedWorkKindDecision(): RequestedWorkKindDecision {
  return {
    kind: 'unknown',
    source: 'system_default',
    confidence: null,
  };
}

/**
 * Fast path through the optional judgment model. Returns `undefined` when it
 * is not configured, fails, or is not confident, so the helper model decides.
 */
async function classifyWithJudgmentModel(
  prompt: string,
): Promise<RequestedWorkKindDecision | undefined> {
  try {
    const answers = await evaluateTypeSafeJudgments({
      state: { prompt },
      questions: { kind: REQUESTED_WORK_KIND_QUESTION },
    });

    if (!answers || answers.kind.confidence < JUDGMENT_MIN_CONFIDENCE) {
      return undefined;
    }

    return {
      kind: answers.kind.choice,
      source: 'llm_classifier',
      confidence: answers.kind.confidence,
    };
  } catch (error) {
    console.warn(
      `[RequestedWorkKind] Judgment model failed, using the helper model: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

export async function classifyRequestedWorkKindFromPrompt(
  prompt: string,
  tracking?: {
    userId?: string | null;
    taskId?: string | null;
  },
): Promise<RequestedWorkKindDecision> {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return getSystemDefaultRequestedWorkKindDecision();
  }

  const judgmentDecision = await classifyWithJudgmentModel(trimmedPrompt);

  if (judgmentDecision) {
    return judgmentDecision;
  }

  const { object } = await generateTrackedNonTaskObject({
    userId: tracking?.userId,
    taskId: tracking?.taskId,
    surface: NON_TASK_INFERENCE_SURFACES.routerRequestedWorkKind,
    timeoutMs: REQUESTED_WORK_KIND_TIMEOUT_MS,
    schema: requestedWorkKindClassifierResponseSchema,
    system: REQUESTED_WORK_KIND_PROMPT,
    prompt: trimmedPrompt,
  });

  return {
    kind: object.kind,
    source: 'llm_classifier',
    confidence: normalizeConfidence(object.confidence),
  };
}

export async function resolveRequestedWorkKindDecision(params: {
  prompt?: string | null;
  bootstrapSkill?: ExplicitBootstrapSkill | null;
  taskToolActionId?: TaskToolActionId | null;
  inheritedKind?: RequestedWorkKind | null;
  userId?: string | null;
  taskId?: string | null;
}): Promise<RequestedWorkKindDecision> {
  const explicitBootstrapDecision =
    getExplicitBootstrapRequestedWorkKindDecision(params.bootstrapSkill);
  if (explicitBootstrapDecision) {
    return explicitBootstrapDecision;
  }

  const taskToolDecision = getTaskToolRequestedWorkKindDecision(
    params.taskToolActionId,
  );
  if (taskToolDecision) {
    return taskToolDecision;
  }

  const inheritedDecision = getInheritedRequestedWorkKindDecision(
    params.inheritedKind,
  );
  if (inheritedDecision) {
    return inheritedDecision;
  }

  const trimmedPrompt = params.prompt?.trim();
  if (!trimmedPrompt) {
    return getSystemDefaultRequestedWorkKindDecision();
  }

  try {
    return await classifyRequestedWorkKindFromPrompt(trimmedPrompt, {
      userId: params.userId,
      taskId: params.taskId,
    });
  } catch (error) {
    console.warn(
      `[RequestedWorkKind] Classification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return getSystemDefaultRequestedWorkKindDecision();
  }
}
