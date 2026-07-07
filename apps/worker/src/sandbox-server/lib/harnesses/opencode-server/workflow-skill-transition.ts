import { PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS } from '@roomote/cloud-agents';

/** Packaged workflow skill that pins prompts onto the read-mostly plan-mode agent. */
export const PLAN_WORKFLOW_SKILL = 'plan-repo-implementation';

const WORKFLOW_PHASE_SKILL_SET = new Set<string>(
  PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS,
);

interface WorkflowSkillTransition {
  /** The active workflow skill after the load event is applied. */
  nextSkill: string | null;
  /**
   * Whether the harness should queue one hidden continuation prompt so the
   * turn resumes on the writable agent after the current turn ends.
   */
  queueContinuation: boolean;
}

/**
 * Pure transition rule for the primary session's active workflow skill.
 *
 * Loading any packaged workflow skill flips the active skill (existing
 * behavior). The one special case is the plan-mode exit: when the previous
 * skill was `plan-repo-implementation`, a different packaged workflow skill is
 * loaded, and a turn is in flight, the current turn is still pinned to the
 * read-only plan-mode agent, so the harness must queue a continuation prompt
 * that drains after the turn ends and submits on the writable agent.
 * Re-entering the plan skill never queues a continuation.
 */
export function resolveWorkflowSkillTransition({
  previousSkill,
  loadedSkill,
  inFlight,
}: {
  previousSkill: string | null;
  loadedSkill: string;
  inFlight: boolean;
}): WorkflowSkillTransition {
  if (!WORKFLOW_PHASE_SKILL_SET.has(loadedSkill)) {
    return { nextSkill: previousSkill, queueContinuation: false };
  }

  return {
    nextSkill: loadedSkill,
    queueContinuation:
      inFlight &&
      previousSkill === PLAN_WORKFLOW_SKILL &&
      loadedSkill !== PLAN_WORKFLOW_SKILL,
  };
}
