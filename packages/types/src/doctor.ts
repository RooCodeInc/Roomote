import { z } from 'zod';

export const doctorCheckStatusSchema = z.enum([
  'pass',
  'warn',
  'fail',
  'unknown',
]);

export const doctorCheckSeveritySchema = z.enum([
  'info',
  'minor',
  'major',
  'critical',
]);

export const doctorCheckIdSchema = z
  .string()
  .regex(
    /^(?:setup\.commands(?:\.[a-z0-9._-]+)?|setup\.detached_health|docker\.projects|service\.[a-zA-Z0-9_-]+|port\.[a-zA-Z][a-zA-Z0-9_]*\.(?:loopback|preview)|tooling\.versions|env\.contract)$/u,
    'Doctor check ID must use a supported stable namespace',
  );

export const doctorCheckSchema = z.object({
  id: doctorCheckIdSchema,
  category: z.string().min(1),
  title: z.string().min(1),
  status: doctorCheckStatusSchema,
  severity: doctorCheckSeveritySchema,
  summary: z.string().min(1),
  details: z.string().min(1).optional(),
  remediationHint: z.string().min(1).optional(),
  observedAt: z.string().datetime(),
  durationMs: z.number().nonnegative().optional(),
});

export type DoctorCheckStatus = z.infer<typeof doctorCheckStatusSchema>;
export type DoctorCheckSeverity = z.infer<typeof doctorCheckSeveritySchema>;
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const doctorReportSchema = z.object({
  generatedAt: z.string().datetime(),
  overallStatus: doctorCheckStatusSchema,
  checks: z.array(doctorCheckSchema),
});

export type DoctorReport = z.infer<typeof doctorReportSchema>;

const STATUS_WEIGHT: Record<DoctorCheckStatus, number> = {
  pass: 0,
  warn: 1,
  unknown: 2,
  fail: 3,
};

export function getDoctorOverallStatus(
  checks: readonly Pick<DoctorCheck, 'status'>[],
): DoctorCheckStatus {
  return checks.reduce<DoctorCheckStatus>(
    (worst, check) =>
      STATUS_WEIGHT[check.status] > STATUS_WEIGHT[worst] ? check.status : worst,
    'pass',
  );
}

function redactKnownValues(text: string, sensitiveValues: readonly string[]) {
  return [...new Set(sensitiveValues)]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, value) => redacted.replaceAll(value, '[redacted]'),
      text,
    );
}

/**
 * Construct a validated report while removing values known to be sensitive.
 * Callers remain responsible for sanitizing unstructured evidence before it
 * becomes a check; this guard prevents known values from surviving serialization.
 */
export function createDoctorReport(
  checks: DoctorCheck[],
  options: { generatedAt?: string; sensitiveValues?: readonly string[] } = {},
): DoctorReport {
  const sensitiveValues = options.sensitiveValues ?? [];
  const redactedChecks = checks.map((check) => ({
    ...check,
    summary: redactKnownValues(check.summary, sensitiveValues),
    ...(check.details
      ? { details: redactKnownValues(check.details, sensitiveValues) }
      : {}),
    ...(check.remediationHint
      ? {
          remediationHint: redactKnownValues(
            check.remediationHint,
            sensitiveValues,
          ),
        }
      : {}),
  }));

  return doctorReportSchema.parse({
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    overallStatus: getDoctorOverallStatus(redactedChecks),
    checks: redactedChecks,
  });
}
