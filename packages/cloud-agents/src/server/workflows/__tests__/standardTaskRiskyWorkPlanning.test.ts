import { standardTask } from '../standardTask';

describe('Standard Task risky-work planning guidance', () => {
  it('tells lifecycle-heavy work to think through failure scenarios before editing', () => {
    const { harnessInstructions } = standardTask({
      description: 'Fix a flaky cleanup path in the worker lifecycle',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      'When the active work has real lifecycle, cleanup, partial-failure, or race-condition complexity, pause inside the implementation workflow to think through concrete failure scenarios and produce a focused plan before editing.',
    );
    expect(harnessInstructions).toContain(
      'do not turn ordinary low-risk changes into plan-only work.',
    );
  });
});
