import {
  createEnvironmentObservation,
  doctorReportSchema,
  environmentObservationSchema,
} from './doctor';

const observedAt = '2026-08-10T12:00:00.000Z';

describe('Doctor contracts', () => {
  it('keeps deterministic observations separate from Doctor assessment', () => {
    const observation = createEnvironmentObservation(
      [
        {
          id: 'port.WEB.loopback',
          category: 'ports',
          title: 'WEB loopback',
          status: 'pass',
          severity: 'info',
          summary: 'HTTP 200',
          observedAt,
        },
        {
          id: 'tooling.versions',
          category: 'tooling',
          title: 'Tool versions',
          status: 'fail',
          severity: 'major',
          summary: 'Node version mismatch',
          observedAt,
        },
      ],
      { generatedAt: observedAt },
    );

    expect(environmentObservationSchema.parse(observation)).toEqual(
      observation,
    );
    expect(observation.overallStatus).toBe('fail');
    expect(doctorReportSchema.safeParse(observation).success).toBe(false);
  });

  it('requires a final report to record assessment, repair, and verification', () => {
    const observation = createEnvironmentObservation(
      [
        {
          id: 'setup.commands',
          category: 'setup',
          title: 'Setup commands',
          status: 'fail',
          severity: 'critical',
          summary: 'Setup did not complete',
          observedAt,
        },
      ],
      { generatedAt: observedAt },
    );
    const report = doctorReportSchema.parse({
      generatedAt: observedAt,
      observation,
      assessment: {
        summary: 'The configured environment cannot finish setup.',
        goals: ['environment_start', 'failure_ownership'],
        owner: 'environment_configuration',
        confidence: 'high',
        evidenceCheckIds: ['setup.commands'],
      },
      repair: {
        status: 'not_attempted',
        summary: 'Repair requires the environment-setup workflow.',
        delegatedWorkflow: 'environment-setup',
      },
      verification: {
        status: 'not_run',
        summary: 'No repair was authorized, so verification was not run.',
        evidenceCheckIds: [],
      },
      outcome: 'unresolved',
    });

    expect(report.assessment.owner).toBe('environment_configuration');
    expect(report.repair.delegatedWorkflow).toBe('environment-setup');
  });

  it('rejects healthy or repaired outcomes without independent verification', () => {
    const observation = createEnvironmentObservation([], {
      generatedAt: observedAt,
    });
    const unverifiedHealthyReport = {
      generatedAt: observedAt,
      observation,
      assessment: {
        summary: 'No failing probes were observed.',
        goals: ['environment_start'],
        owner: 'undetermined',
        confidence: 'medium',
        evidenceCheckIds: [],
      },
      repair: {
        status: 'not_needed',
        summary: 'No repair was indicated.',
      },
      verification: {
        status: 'not_run',
        summary: 'The startup journey was not repeated.',
        evidenceCheckIds: [],
      },
      outcome: 'healthy',
    };

    expect(doctorReportSchema.safeParse(unverifiedHealthyReport).success).toBe(
      false,
    );
  });

  it('rejects outcomes that contradict the authorized repair boundary', () => {
    const observation = createEnvironmentObservation([], {
      generatedAt: observedAt,
    });
    const verifiedReport = {
      generatedAt: observedAt,
      observation,
      assessment: {
        summary: 'The requested journey passed.',
        goals: ['environment_start'],
        owner: 'undetermined',
        confidence: 'high',
        evidenceCheckIds: [],
      },
      verification: {
        status: 'passed',
        summary: 'The startup journey completed successfully.',
        evidenceCheckIds: [],
      },
    };

    expect(
      doctorReportSchema.safeParse({
        ...verifiedReport,
        repair: {
          status: 'applied',
          summary: 'A repair was applied without an authorized workflow.',
        },
        outcome: 'repaired',
      }).success,
    ).toBe(false);
    expect(
      doctorReportSchema.safeParse({
        ...verifiedReport,
        repair: {
          status: 'not_attempted',
          summary: 'Repair was not attempted.',
        },
        outcome: 'healthy',
      }).success,
    ).toBe(false);
  });

  it('redacts known environment values from serialized observations', () => {
    const env = {
      API_KEY: 'doctor-known-secret-value',
      DATABASE_URL: 'postgresql://doctor:password@example.test/database',
    };
    const observation = createEnvironmentObservation(
      [
        {
          id: 'env.contract',
          category: 'environment',
          title: 'Environment contract',
          status: 'warn',
          severity: 'minor',
          summary: `API_KEY resolved to ${env.API_KEY}`,
          details: `Connection was ${env.DATABASE_URL}`,
          remediationHint: `Do not reuse ${env.API_KEY}`,
          observedAt,
        },
      ],
      {
        generatedAt: observedAt,
        sensitiveValues: Object.values(env),
      },
    );
    const serialized = JSON.stringify(observation);

    expect(serialized).not.toContain(env.API_KEY);
    expect(serialized).not.toContain(env.DATABASE_URL);
    expect(serialized).toContain('[redacted]');
  });
});
