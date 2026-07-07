import { standardTask } from '../standardTask';

describe('Standard Task surface context', () => {
  it('tells plain standard tasks to use the web-dashboard surface rules', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain('<task_surface_context>');
    expect(harnessInstructions).toContain(
      'This StandardTask run was launched from the Roomote web task UI.',
    );
    expect(harnessInstructions).toContain(
      'If a workflow or packaged skill distinguishes web dashboard tasks from other surfaces, treat this run as a web dashboard task.',
    );
    expect(harnessInstructions).toContain(
      'When a secure web-task flow exists for the current step, prefer that flow over asking the user to paste secrets into chat or make local-only task edits.',
    );
  });

  it('does not label GitHub task runs as generic web-dashboard tasks', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskSurface: 'github',
    });

    expect(harnessInstructions).toContain(
      'This run was launched from a GitHub conversation surface and also has a Roomote web task view.',
    );
    expect(harnessInstructions).toContain(
      'If a workflow or packaged skill distinguishes GitHub-started tasks from other surfaces, treat this run as GitHub-started rather than as a generic web dashboard task.',
    );
    expect(harnessInstructions).not.toContain(
      'When a secure web-task flow exists for the current step, prefer that flow over asking the user to paste secrets into chat or make local-only task edits.',
    );
  });

  it('labels Teams-started standard tasks as Teams conversation runs', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskSurface: 'teams',
    });

    expect(harnessInstructions).toContain(
      'This run was launched from a Microsoft Teams conversation surface and also has a Roomote web task view.',
    );
    expect(harnessInstructions).toContain(
      'treat this run as Teams-started rather than as a generic web dashboard task.',
    );
  });

  it('labels Telegram-started standard tasks as Telegram conversation runs', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskSurface: 'telegram',
    });

    expect(harnessInstructions).toContain(
      'This run was launched from a Telegram conversation surface and also has a Roomote web task view.',
    );
    expect(harnessInstructions).toContain(
      'treat this run as Telegram-started rather than as a generic web dashboard task.',
    );
  });

  it('labels Gitea-started review tasks as Gitea pull request runs', () => {
    const { harnessInstructions } = standardTask({
      description: 'Review pull request',
      repo: 'Roomote/example-app',
      taskSurface: 'gitea',
    });

    expect(harnessInstructions).toContain(
      'This run was launched from a Gitea pull request surface and also has a Roomote web task view.',
    );
    expect(harnessInstructions).toContain(
      'treat this run as Gitea-started rather than as a generic web dashboard task.',
    );
    expect(harnessInstructions).toContain(
      'do not use GitHub-only CLI commands such as `gh pr`',
    );
  });

  it('labels Azure DevOps-started review tasks as Azure DevOps pull request runs', () => {
    const { harnessInstructions } = standardTask({
      description: 'Review pull request',
      repo: 'Roomote/example-app',
      taskSurface: 'ado',
    });

    expect(harnessInstructions).toContain(
      'This run was launched from an Azure DevOps pull request surface and also has a Roomote web task view.',
    );
    expect(harnessInstructions).toContain(
      'treat this run as Azure DevOps-started rather than as a generic web dashboard task.',
    );
    expect(harnessInstructions).toContain(
      'do not use GitHub-only CLI commands such as `gh pr`',
    );
  });
});
