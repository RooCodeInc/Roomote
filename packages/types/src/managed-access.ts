import { z } from 'zod';

export const MANAGED_ACCESS_METADATA_KEY = 'managed_access';

export const ManagedAccessState = {
  Active: 'active',
  ReadOnly: 'read_only',
} as const;

export type ManagedAccessState =
  (typeof ManagedAccessState)[keyof typeof ManagedAccessState];

export const ManagedAccessReason = {
  PaymentPastDue: 'payment_past_due',
  BillingRequired: 'billing_required',
} as const;

export type ManagedAccessReason =
  (typeof ManagedAccessReason)[keyof typeof ManagedAccessReason];

const managedAccessDecisionBaseSchema = z.object({
  iss: z.literal('roomote-cloud'),
  aud: z.string().min(1),
  state: z.enum([ManagedAccessState.Active, ManagedAccessState.ReadOnly]),
  reason: z
    .enum([
      ManagedAccessReason.PaymentPastDue,
      ManagedAccessReason.BillingRequired,
    ])
    .nullable(),
  revision: z.number().int().positive().safe(),
  effectiveAt: z.string().datetime({ offset: true }),
  restrictionStartsAt: z.string().datetime({ offset: true }).nullable(),
  remediationUrl: z.string().url().nullable(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});

function refineManagedAccessCombination(
  decision: {
    state: ManagedAccessState;
    reason: ManagedAccessReason | null;
    restrictionStartsAt: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (
    decision.state === ManagedAccessState.Active &&
    decision.reason === null &&
    decision.restrictionStartsAt === null
  ) {
    return;
  }

  if (
    decision.state === ManagedAccessState.Active &&
    decision.reason === ManagedAccessReason.PaymentPastDue &&
    decision.restrictionStartsAt !== null
  ) {
    return;
  }

  if (
    decision.state === ManagedAccessState.ReadOnly &&
    decision.reason === ManagedAccessReason.BillingRequired &&
    decision.restrictionStartsAt === null
  ) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Invalid managed access state/reason combination.',
  });
}

function refineUtcTimestamp(value: string, ctx: z.RefinementCtx) {
  if (!value.endsWith('Z')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Timestamp must be UTC.',
    });
  }
}

export const managedAccessDecisionSchema = managedAccessDecisionBaseSchema
  .superRefine(refineManagedAccessCombination)
  .superRefine((decision, ctx) => {
    refineUtcTimestamp(decision.effectiveAt, ctx);

    if (decision.restrictionStartsAt !== null) {
      refineUtcTimestamp(decision.restrictionStartsAt, ctx);
    }
  });

export type ManagedAccessDecision = z.infer<typeof managedAccessDecisionSchema>;

export type ManagedDeploymentAccess = Pick<
  ManagedAccessDecision,
  | 'state'
  | 'reason'
  | 'revision'
  | 'effectiveAt'
  | 'restrictionStartsAt'
  | 'remediationUrl'
>;

export const managedDeploymentAccessSchema = managedAccessDecisionBaseSchema
  .pick({
    state: true,
    reason: true,
    revision: true,
    effectiveAt: true,
    restrictionStartsAt: true,
    remediationUrl: true,
  })
  .superRefine(refineManagedAccessCombination)
  .superRefine((decision, ctx) => {
    refineUtcTimestamp(decision.effectiveAt, ctx);

    if (decision.restrictionStartsAt !== null) {
      refineUtcTimestamp(decision.restrictionStartsAt, ctx);
    }
  });

export const DEFAULT_MANAGED_DEPLOYMENT_ACCESS: ManagedDeploymentAccess = {
  state: ManagedAccessState.Active,
  reason: null,
  revision: 0,
  effectiveAt: '1970-01-01T00:00:00.000Z',
  restrictionStartsAt: null,
  remediationUrl: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeManagedDeploymentAccess(
  value: unknown,
): ManagedDeploymentAccess {
  const parsed = managedDeploymentAccessSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_MANAGED_DEPLOYMENT_ACCESS;
}

export function getManagedDeploymentAccessFromMetadata(
  metadata: unknown,
): ManagedDeploymentAccess {
  if (!isRecord(metadata)) {
    return DEFAULT_MANAGED_DEPLOYMENT_ACCESS;
  }

  return normalizeManagedDeploymentAccess(
    metadata[MANAGED_ACCESS_METADATA_KEY],
  );
}

export function isManagedDeploymentReadOnly(metadata: unknown): boolean {
  return (
    getManagedDeploymentAccessFromMetadata(metadata).state ===
    ManagedAccessState.ReadOnly
  );
}

export function isRoomoteDeploymentDisabled(metadata: unknown): boolean {
  return isRecord(metadata) && metadata.deployment_disabled === true;
}
