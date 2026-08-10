import { createDoctorReport, doctorReportSchema } from './doctor';

const observedAt = '2026-08-10T12:00:00.000Z';

describe('DoctorReport', () => {
  it('validates supported check IDs and derives the worst status', () => {
    const report = createDoctorReport(
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

    expect(doctorReportSchema.parse(report)).toEqual(report);
    expect(report.overallStatus).toBe('fail');
  });

  it('redacts known environment values from serialized reports', () => {
    const env = {
      API_KEY: 'doctor-known-secret-value',
      DATABASE_URL: 'postgresql://doctor:password@example.test/database',
    };
    const report = createDoctorReport(
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
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(env.API_KEY);
    expect(serialized).not.toContain(env.DATABASE_URL);
    expect(serialized).toContain('[redacted]');
  });
});
