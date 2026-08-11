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
});
