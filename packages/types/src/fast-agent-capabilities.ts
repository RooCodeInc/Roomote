import { z } from 'zod';

import { sourceControlProviderSchema } from './source-control';

export const FAST_AGENT_CAPABILITY_IDS = [
  'source_control',
  'integrations',
  'starter_work',
  'sandbox',
  'automation_recommendations',
] as const;

export const fastAgentCapabilityIdSchema = z.enum(FAST_AGENT_CAPABILITY_IDS);
export type FastAgentCapabilityId = z.infer<typeof fastAgentCapabilityIdSchema>;

export const fastAgentCapabilityOfferInputSchema = z.object({
  capability: fastAgentCapabilityIdSchema,
  message: z.string().trim().min(1).max(500),
  provider: sourceControlProviderSchema.optional(),
  integrationIds: z.array(z.string().trim().min(1)).max(20).optional(),
});

export type FastAgentCapabilityOfferInput = z.infer<
  typeof fastAgentCapabilityOfferInputSchema
>;

export interface FastAgentCapabilityOfferPayload extends FastAgentCapabilityOfferInput {
  offerId: string;
  status: 'pending';
}

export interface FastAgentCapabilityOfferResponsePayload {
  offerId: string;
  capability: FastAgentCapabilityId;
  resolution: 'completed' | 'dismissed';
  selectedIds?: string[];
}

export interface FastAgentCapabilitySnapshot {
  setupCompleted: boolean;
  recommendedNextCapability: FastAgentCapabilityId | null;
  initialMilestones?: Partial<
    Record<
      FastAgentCapabilityId,
      'offered' | 'completed' | 'declined' | 'deferred'
    >
  >;
  capabilities: Record<
    FastAgentCapabilityId,
    {
      canOffer: boolean;
      ready: boolean;
      unavailableReason?: string;
    }
  >;
}

const fastAgentCapabilitySnapshotSchema = z.object({
  setupCompleted: z.boolean(),
  recommendedNextCapability: fastAgentCapabilityIdSchema.nullable(),
  capabilities: z.object(
    Object.fromEntries(
      FAST_AGENT_CAPABILITY_IDS.map((capability) => [
        capability,
        z.object({
          canOffer: z.boolean(),
          ready: z.boolean(),
          unavailableReason: z.string().optional(),
        }),
      ]),
    ) as Record<
      FastAgentCapabilityId,
      z.ZodObject<{
        canOffer: z.ZodBoolean;
        ready: z.ZodBoolean;
        unavailableReason: z.ZodOptional<z.ZodString>;
      }>
    >,
  ),
  initialMilestones: z
    .record(
      fastAgentCapabilityIdSchema,
      z.enum(['offered', 'completed', 'declined', 'deferred']),
    )
    .optional(),
});

export function parseFastAgentCapabilitySnapshot(
  value: unknown,
): FastAgentCapabilitySnapshot | null {
  try {
    const parsed = fastAgentCapabilitySnapshotSchema.safeParse(
      typeof value === 'string' ? JSON.parse(value) : value,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseFastAgentCapabilityOfferPayload(
  value: unknown,
): FastAgentCapabilityOfferPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const offerId = typeof record.offerId === 'string' ? record.offerId : null;
  const parsed = fastAgentCapabilityOfferInputSchema.safeParse(record);
  return offerId && parsed.success
    ? { offerId, status: 'pending', ...parsed.data }
    : null;
}

export function parseFastAgentCapabilityOfferResponsePayload(
  value: unknown,
): FastAgentCapabilityOfferResponsePayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const capability = fastAgentCapabilityIdSchema.safeParse(record.capability);
  const selectedIds = z.array(z.string()).max(20).safeParse(record.selectedIds);
  return typeof record.offerId === 'string' &&
    capability.success &&
    (record.resolution === 'completed' || record.resolution === 'dismissed')
    ? {
        offerId: record.offerId,
        capability: capability.data,
        resolution: record.resolution,
        ...(selectedIds.success ? { selectedIds: selectedIds.data } : {}),
      }
    : null;
}
