import {
  buildEnvironmentVerificationPrompt,
  getLinkedEnvironmentIdFromPayload,
} from './environment-definition-tasks';

describe('getLinkedEnvironmentIdFromPayload', () => {
  it('reads a standard task environment id', () => {
    expect(
      getLinkedEnvironmentIdFromPayload({ environmentId: 'environment-123' }),
    ).toBe('environment-123');
  });

  it('falls back to environment-definition workflow payload keys', () => {
    expect(
      getLinkedEnvironmentIdFromPayload({
        environmentDefinitionId: 'definition-123',
      }),
    ).toBe('definition-123');
  });

  it('rejects empty and non-object values', () => {
    expect(getLinkedEnvironmentIdFromPayload({ environmentId: '  ' })).toBe(
      null,
    );
    expect(getLinkedEnvironmentIdFromPayload(null)).toBe(null);
  });
});

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
      'Do not invoke Doctor or another workflow skill, launch another task, repair or update the environment',
    );
    expect(prompt).toContain(
      'Do not assume that a service, port, HTTP endpoint, browser preview, test suite, container, or long-running process exists.',
    );
    expect(prompt).toContain(
      'Report success only when the applicable workflow actually completes.',
    );
    expect(prompt).toContain('`action: "record_verification"`');
  });

  it('tells the task to wait with one bounded blocking command instead of short sleeps', () => {
    const prompt = buildEnvironmentVerificationPrompt({
      environmentId: 'environment-123',
      environmentName: 'Example',
    });

    expect(prompt).toContain(
      'Wait with a single bounded blocking shell command (for example one `timeout`-wrapped poll loop in one tool call) instead of many separate short sleep calls across turns',
    );
    expect(prompt).toContain(
      "treat the platform's environment-setup update message as the completion signal when one arrives",
    );
  });

  it('carves out clearly pre-existing repository test failures from readiness', () => {
    const prompt = buildEnvironmentVerificationPrompt({
      environmentId: 'environment-123',
      environmentName: 'Example',
    });

    expect(prompt).toContain('Classify any test failures before deciding');
    expect(prompt).toContain(
      'failures that point to a setup or environment-definition problem',
    );
    expect(prompt).toContain(
      'treat the environment as ready and list those failures explicitly as pre-existing',
    );
  });
});
