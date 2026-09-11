import { standardTask } from '../standardTask';

describe('Standard Task task-launch policy', () => {
  it('forbids child-task launches without exceptions', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'Sandbox tasks cannot launch other Roomote tasks. The task-management tool intentionally does not expose a launch action, and run-scoped tokens are rejected by the task-launch API. Use in-process subagents for bounded assistance; leave any separate top-level Roomote task launch to Fast or an authenticated user.',
    );
    expect(harnessInstructions).not.toContain('standard exceptions');
  });
});
