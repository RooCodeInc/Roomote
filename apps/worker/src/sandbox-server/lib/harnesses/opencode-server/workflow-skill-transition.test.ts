import { describe, expect, it } from 'vitest';

import {
  PLAN_WORKFLOW_SKILL,
  resolveWorkflowSkillTransition,
} from './workflow-skill-transition';

describe('resolveWorkflowSkillTransition', () => {
  it('flips the active skill when a packaged workflow skill is loaded', () => {
    expect(
      resolveWorkflowSkillTransition({
        previousSkill: null,
        loadedSkill: 'implement-changes',
        inFlight: true,
      }),
    ).toEqual({ nextSkill: 'implement-changes', queueContinuation: false });
  });

  it('keeps the previous skill for non-workflow skill loads', () => {
    expect(
      resolveWorkflowSkillTransition({
        previousSkill: PLAN_WORKFLOW_SKILL,
        loadedSkill: 'some-repo-local-skill',
        inFlight: true,
      }),
    ).toEqual({ nextSkill: PLAN_WORKFLOW_SKILL, queueContinuation: false });
  });

  it('queues a continuation when an in-flight turn exits the plan workflow', () => {
    expect(
      resolveWorkflowSkillTransition({
        previousSkill: PLAN_WORKFLOW_SKILL,
        loadedSkill: 'implement-changes',
        inFlight: true,
      }),
    ).toEqual({ nextSkill: 'implement-changes', queueContinuation: true });
  });

  it('does not queue a continuation when no turn is in flight', () => {
    expect(
      resolveWorkflowSkillTransition({
        previousSkill: PLAN_WORKFLOW_SKILL,
        loadedSkill: 'implement-changes',
        inFlight: false,
      }),
    ).toEqual({ nextSkill: 'implement-changes', queueContinuation: false });
  });

  it('does not queue a continuation when the previous skill is not the plan workflow', () => {
    expect(
      resolveWorkflowSkillTransition({
        previousSkill: 'implement-changes',
        loadedSkill: 'create-draft-pr',
        inFlight: true,
      }),
    ).toEqual({ nextSkill: 'create-draft-pr', queueContinuation: false });
  });

  it('does not queue a continuation when re-loading the plan workflow skill', () => {
    expect(
      resolveWorkflowSkillTransition({
        previousSkill: PLAN_WORKFLOW_SKILL,
        loadedSkill: PLAN_WORKFLOW_SKILL,
        inFlight: true,
      }),
    ).toEqual({ nextSkill: PLAN_WORKFLOW_SKILL, queueContinuation: false });
  });

  it('does not queue a continuation when entering the plan workflow mid-turn', () => {
    expect(
      resolveWorkflowSkillTransition({
        previousSkill: 'implement-changes',
        loadedSkill: PLAN_WORKFLOW_SKILL,
        inFlight: true,
      }),
    ).toEqual({ nextSkill: PLAN_WORKFLOW_SKILL, queueContinuation: false });
  });
});
