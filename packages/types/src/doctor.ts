import { z } from 'zod';

export const environmentObservationStatusSchema = z.enum([
  'pass',
  'warn',
  'fail',
  'unknown',
]);

export const environmentObservationSeveritySchema = z.enum([
  'info',
  'minor',
  'major',
  'critical',
]);

export const environmentObservationCheckIdSchema = z
  .string()
  .regex(
    /^(?:context\.available|setup\.commands(?:\.[a-z0-9._-]+)?|setup\.detached_health|setup\.repository_changes|docker\.projects|service\.[a-zA-Z0-9_-]+|port\.[a-zA-Z][a-zA-Z0-9_]*\.(?:loopback|preview)|tooling\.versions|env\.contract)$/u,
    'Environment observation check ID must use a supported stable namespace',
  );

export const environmentObservationCheckSchema = z.object({
  id: environmentObservationCheckIdSchema,
  category: z.string().min(1),
  title: z.string().min(1),
  status: environmentObservationStatusSchema,
  severity: environmentObservationSeveritySchema,
  summary: z.string().min(1),
  details: z.string().min(1).optional(),
  remediationHint: z.string().min(1).optional(),
  observedAt: z.string().datetime(),
  durationMs: z.number().nonnegative().optional(),
});

export type EnvironmentObservationStatus = z.infer<
  typeof environmentObservationStatusSchema
>;
export type EnvironmentObservationSeverity = z.infer<
  typeof environmentObservationSeveritySchema
>;
export type EnvironmentObservationCheck = z.infer<
  typeof environmentObservationCheckSchema
>;

/**
 * Secret-safe probe output. This is evidence for Doctor to assess, not an
 * environment verification result or authorization to repair anything.
 */
export const environmentObservationSchema = z.object({
  generatedAt: z.string().datetime(),
  overallStatus: environmentObservationStatusSchema,
  checks: z.array(environmentObservationCheckSchema),
});

export type EnvironmentObservation = z.infer<
  typeof environmentObservationSchema
>;

export const doctorGoalSchema = z.enum([
  'environment_start',
  'service_start',
  'preview_reachability',
  'visual_proof',
  'test_execution',
  'performance',
  'failure_ownership',
]);

export const doctorFailureOwnerSchema = z.enum([
  'environment_configuration',
  'repository',
  'roomote_platform',
  'external_dependency',
  'undetermined',
]);

export const doctorRepairStatusSchema = z.enum([
  'not_needed',
  'not_attempted',
  'applied',
  'blocked',
  'not_allowed',
]);

export const doctorVerificationStatusSchema = z.enum([
  'not_run',
  'passed',
  'failed',
  'blocked',
]);

export const doctorOutcomeSchema = z.enum([
  'healthy',
  'repaired',
  'unresolved',
  'needs_user',
  'platform_issue',
]);

/**
 * Doctor's final assessment after observation, any separately authorized
 * repair, and independent verification. The diagnostic tool never creates it.
 */
export const doctorReportObjectSchema = z.object({
  generatedAt: z.string().datetime(),
  observation: environmentObservationSchema,
  assessment: z.object({
    summary: z.string().min(1),
    goals: z.array(doctorGoalSchema).min(1),
    owner: doctorFailureOwnerSchema,
    confidence: z.enum(['low', 'medium', 'high']),
    evidenceCheckIds: z.array(environmentObservationCheckIdSchema),
  }),
  repair: z.object({
    status: doctorRepairStatusSchema,
    summary: z.string().min(1),
    delegatedWorkflow: z
      .enum(['environment-setup', 'implement-changes'])
      .optional(),
  }),
  verification: z.object({
    status: doctorVerificationStatusSchema,
    summary: z.string().min(1),
    evidenceCheckIds: z.array(environmentObservationCheckIdSchema),
  }),
  outcome: doctorOutcomeSchema,
});

export const doctorReportSchema = doctorReportObjectSchema.superRefine(
  (report, context) => {
    if (
      (report.outcome === 'healthy' || report.outcome === 'repaired') &&
      report.verification.status !== 'passed'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${report.outcome} outcomes require passed verification`,
        path: ['verification', 'status'],
      });
    }
    if (report.outcome === 'repaired' && report.repair.status !== 'applied') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repaired outcomes require an applied repair',
        path: ['repair', 'status'],
      });
    }
    if (
      report.repair.status === 'applied' &&
      report.repair.delegatedWorkflow === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'applied repairs require a delegated workflow',
        path: ['repair', 'delegatedWorkflow'],
      });
    }
    if (report.outcome === 'healthy' && report.repair.status !== 'not_needed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'healthy outcomes require repair status not_needed',
        path: ['repair', 'status'],
      });
    }
  },
);

export type DoctorReport = z.infer<typeof doctorReportSchema>;

const STATUS_WEIGHT: Record<EnvironmentObservationStatus, number> = {
  pass: 0,
  warn: 1,
  unknown: 2,
  fail: 3,
};

export function getEnvironmentObservationOverallStatus(
  checks: readonly Pick<EnvironmentObservationCheck, 'status'>[],
): EnvironmentObservationStatus {
  return checks.reduce<EnvironmentObservationStatus>(
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
 * Construct validated probe evidence while removing values known to be
 * sensitive. Callers must still sanitize unstructured evidence first.
 */
export function createEnvironmentObservation(
  checks: EnvironmentObservationCheck[],
  options: { generatedAt?: string; sensitiveValues?: readonly string[] } = {},
): EnvironmentObservation {
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

  return environmentObservationSchema.parse({
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    overallStatus: getEnvironmentObservationOverallStatus(redactedChecks),
    checks: redactedChecks,
  });
}
