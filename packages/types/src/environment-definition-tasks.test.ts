import { buildEnvironmentVerificationPrompt } from './environment-definition-tasks';

describe('buildEnvironmentVerificationPrompt', () => {
  it('routes verification retries through Doctor without authorizing repair', () => {
    const prompt = buildEnvironmentVerificationPrompt({
      environmentId: 'environment-123',
      environmentName: 'Example',
    });

    expect(prompt.startsWith('$doctor\n')).toBe(true);
    expect(prompt).toContain(
      'This task is the current authorized environment-verification attempt.',
    );
    expect(prompt).toContain('collect the baseline EnvironmentObservation');
    expect(prompt).toContain('do not attempt repairs');
    expect(prompt).toContain('produce a DoctorReport');
    expect(prompt).toContain('`action: "record_verification"`');
  });
});
