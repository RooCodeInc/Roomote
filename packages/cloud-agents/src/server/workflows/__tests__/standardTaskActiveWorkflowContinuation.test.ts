import { standardTask } from '../standardTask';

describe('Standard Task active workflow follow-up handling', () => {
  it('keeps active workflows in place when users send in-flight messages that do not clearly redirect the work', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      'When the user sends a message during an active workflow, answer it and then continue executing the workflow from where it left off, incorporating any adjustments to the current work or transitioning to a different workflow if the message clearly directs different work. User messages during an active workflow are not inherently signals to reclassify or abandon the execution path.',
    );
    expect(harnessInstructions).not.toContain(
      'Monitor for signals that the conversation has shifted to a different kind of work.',
    );
  });
});
