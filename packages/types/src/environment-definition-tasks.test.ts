import { buildEnvironmentVerificationPrompt } from './environment-definition-tasks';

describe('buildEnvironmentVerificationPrompt', () => {
  it('creates a direct read-only verification task without invoking Doctor', () => {
    const prompt = buildEnvironmentVerificationPrompt({
      environmentId: 'environment-123',
      environmentName: 'Example',
    });

    expect(prompt.startsWith('$doctor\n')).toBe(false);
    expect(prompt).toContain(
      'This task is the current authorized environment-verification attempt.',
    );
    expect(prompt).toContain(
      'Do not invoke Doctor or another packaged skill, launch another task, repair or update the environment',
    );
    expect(prompt).toContain(
      'Do not assume that a service, port, HTTP endpoint, browser preview, test suite, container, or long-running process exists.',
    );
    expect(prompt).toContain(
      'Report success only when the applicable workflow actually completes.',
    );
    expect(prompt).toContain('`action: "record_verification"`');
  });
});
