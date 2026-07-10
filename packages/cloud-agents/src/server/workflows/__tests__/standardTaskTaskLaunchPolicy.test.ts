import { standardTask } from '../standardTask';

describe('Standard Task task-launch policy', () => {
  it('forbids child-task launches by default while preserving explicit skill exceptions', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'Do not call the Roomote MCP tool `mcp__roomote__manage_tasks` with `action: "launch"` unless the user explicitly asks for a separate task or the active skill explicitly requires that follow-up task handoff. The standard exception is `environment-setup`, which launches a verification task after persisting an environment.',
    );
  });
});
