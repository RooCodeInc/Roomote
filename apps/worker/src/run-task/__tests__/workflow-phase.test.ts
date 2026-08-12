import {
  getFollowUpWorkflowPhase,
  getInitialWorkflowPhase,
} from '../workflow-phase';

describe('workflow phase selection', () => {
  it('leaves questions unpinned so rendered prompt routing can classify their source', () => {
    expect(
      getInitialWorkflowPhase({
        prompt: 'Where is retry logic implemented?',
        requestedWorkKind: 'question',
      }),
    ).toBeNull();
  });

  it('routes unknown requested work kind into the planning workflow', () => {
    expect(
      getInitialWorkflowPhase({
        prompt: 'Investigate or maybe fix this if it looks easy',
        requestedWorkKind: 'unknown',
      }),
    ).toBe('plan-repo-implementation');
  });

  it('still lets explicit follow-up workflow invocations override the default mapping', () => {
    expect(
      getFollowUpWorkflowPhase('$implement-changes\nProceed with the fix.'),
    ).toBe('implement-changes');
  });
});
