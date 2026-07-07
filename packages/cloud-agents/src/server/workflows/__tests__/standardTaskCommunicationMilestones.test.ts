import { standardTask } from '../standardTask';

describe('Standard Task communication milestones', () => {
  it('keeps communication milestones out of harnessInstructions after they move to the system prompt', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).not.toContain('<communication_milestones>');
    expect(harnessInstructions).not.toContain(
      'Communication milestones define when user-visible updates should be sent on the originating surface. They are distinct from workflow phases and todo steps.',
    );
    expect(harnessInstructions).not.toContain(
      'Use milestone language for externally visible progress and status updates. Use phase language for internal workflow structure.',
    );
    expect(harnessInstructions).not.toContain(
      'Todo progress, internal commentary, and task-UI transcript updates do not satisfy a surface communication milestone unless the active surface policy says they do.',
    );
    expect(harnessInstructions).not.toContain('<milestone id="acknowledged">');
    expect(harnessInstructions).not.toContain('<milestone id="input_needed">');
    expect(harnessInstructions).not.toContain('<milestone id="blocker_found">');
    expect(harnessInstructions).not.toContain(
      '<milestone id="delivery_state_reached">',
    );
    expect(harnessInstructions).not.toContain('<milestone id="completed">');
    expect(harnessInstructions).toContain(
      'The skill defines phases, validation, and completion criteria.',
    );
    expect(harnessInstructions).not.toContain('<response_shape>');
    expect(harnessInstructions).not.toContain('<communication>');
    expect(harnessInstructions).not.toContain(
      'In ordinary intermediary updates and final answers, do not mention internal packaged-skill names, skill selection, or skill transitions unless the user explicitly asks about internal routing or explicitly invoked that skill by name.',
    );
  });
});
