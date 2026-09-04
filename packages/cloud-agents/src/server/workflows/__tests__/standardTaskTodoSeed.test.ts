import { standardTask } from '../standardTask';

describe('Standard Task todo seed', () => {
  it('tells workflow-owned task tracking to override the generic fallback seed', () => {
    const { harnessInstructions } = standardTask({
      description:
        '/plan-repo-implementation\nInvestigate stale todo behavior and propose a fix',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      'If the selected workflow explicitly defines task tracking or todo initialization, follow that workflow-specific structure instead of overriding it with a generic implementation-oriented plan. However, only the active core workflow or a required delegated child delivery path may replace unresolved parent proof, delivery, blocker, or input-needed obligations in the active todo list.',
    );
    expect(harnessInstructions).toContain(
      'When the selected workflow includes repository mutation or delivery work, make the branch/push/PR requirement visible from the start.',
    );
  });

  it('keeps the implementation-oriented seed as a fallback for workflows without explicit task tracking', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      '- Read and understand the request and enter the correct initial workflow',
    );
    expect(harnessInstructions).toContain(
      '- Execute the selected workflow end-to-end',
    );
    expect(harnessInstructions).toContain(
      '- If the implementation changed repository files, load `capture-visual-proof` after implementation and before delivery or any final delivery pause so the proof step can decide whether screenshots, screencasts, both, or no browser proof apply and capture them',
    );
  });

  it('does not special-case explain or plan requests inside the fallback seed', () => {
    const { harnessInstructions } = standardTask({
      description:
        '/plan-repo-implementation\nInvestigate stale todo behavior and propose a fix',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).not.toContain(
      '- Read and understand the planning request',
    );
    expect(harnessInstructions).not.toContain(
      '- Publish the plan artifact and reconcile the final todo state',
    );
  });

  it('treats the active todo list as the current direction instead of a history log', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      'The shared todo discipline lives in the global system prompt.',
    );
    expect(harnessInstructions).toContain(
      'When work transitions between skills or phases, keep the active todo list focused on the current plan: carry forward only items that still matter to the new direction, rewrite the list when most existing items no longer describe the active work, and when a delegated child skill becomes the active execution path rewrite the list to that current child phase while preserving any unresolved parent proof, delivery, blocker, or input-needed obligations.',
    );
    expect(harnessInstructions).toContain(
      'For autonomous repository-changing `implement-changes` runs, unresolved parent proof, delivery, blocker, or input-needed obligations must survive delegated or supplemental-skill transitions until they are resolved.',
    );
    expect(harnessInstructions).toContain(
      'Do not mark validation, push, or pull request items complete before those actions actually succeed.',
    );
    expect(harnessInstructions).toContain(
      'For autonomous repository-changing `implement-changes` runs, keep at least one unresolved proof or delivery todo item until delegated delivery resolves, and do not let validation be the final completed milestone while delivery is still required.',
    );
    expect(harnessInstructions).not.toContain(
      'Before any user-visible final answer or completion handoff, reconcile the todo-management tool with the actual task state.',
    );
    expect(harnessInstructions).not.toContain(
      'Keep exactly one step `in_progress` while actively executing unless genuinely parallel work is underway.',
    );
  });
});
