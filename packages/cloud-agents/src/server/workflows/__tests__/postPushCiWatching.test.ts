import { standardTask } from '../standardTask';

describe('StandardTask CI guidance ownership', () => {
  it('does not inject a shared post-push CI watching policy into every delegated task', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      cloudJobUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).not.toContain('<post_push_ci_policy>');
    expect(harnessInstructions).not.toContain(
      'Whenever any workflow pushes commits to a branch, treat post-push CI verification as part of that same run rather than optional follow-up reporting.',
    );
    expect(harnessInstructions).not.toContain(
      "If that push leaves the branch with an open pull request, whether because the PR already existed or because the workflow created or refreshed it, wait for the PR's GitHub checks to finish before final reporting.",
    );
  });
});
