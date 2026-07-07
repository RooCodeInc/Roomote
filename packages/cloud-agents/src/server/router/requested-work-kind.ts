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
} from '../non-task-provider-usage';

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
- question: explanation, understanding, investigation, diagnosis, or review asks that should remain non-mutating
- plan: planning, scoping, design, sequencing, or proposal asks that should remain non-mutating
- implement: asks to build, fix, change, create, edit, write, run, or otherwise execute repository work
- unknown: the ask is still too conflicting or underspecified to choose even after applying the ambiguity rule below

Classify the user's initial ask only. Do not infer later lifecycle behavior.
When the ask is mixed or ambiguous, use implementation straightforwardness as the tiebreaker:
- choose implement when the likely implementation path is narrow, conventional, and low-decision
- choose plan when the work likely requires meaningful product, scope, or architecture decisions before implementation
- choose unknown only when the request remains too contradictory or underspecified to judge that tiebreaker reliably
Confidence should be a number from 0 to 1 when you can estimate it.
`.trim();

const REQUESTED_WORK_KIND_TIMEOUT_MS = 5_000;

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

export function getExplicitBootstrapRequestedWorkKindDecision(
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

export function getTaskToolRequestedWorkKindDecision(
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

export function getInheritedRequestedWorkKindDecision(
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

export function getSystemDefaultRequestedWorkKindDecision(): RequestedWorkKindDecision {
  return {
    kind: 'unknown',
    source: 'system_default',
    confidence: null,
  };
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
