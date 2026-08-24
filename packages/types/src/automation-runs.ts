import { z } from 'zod';

import { communicationProviderSchema } from './communication';

export const automationRunStatuses = [
  'pending',
  'running',
  'waiting_for_children',
  'succeeded',
  'skipped',
  'failed',
] as const;
export const automationRunStatusSchema = z.enum(automationRunStatuses);
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;

export const automationRunTriggerKinds = ['schedule', 'manual'] as const;
export const automationRunTriggerKindSchema = z.enum(automationRunTriggerKinds);
export type AutomationRunTriggerKind = z.infer<
  typeof automationRunTriggerKindSchema
>;

export const automationExecutionRoutes = [
  'legacy_task',
  'fast',
  'hybrid',
] as const;
export const automationExecutionRouteSchema = z.enum(automationExecutionRoutes);
export type AutomationExecutionRoute = z.infer<
  typeof automationExecutionRouteSchema
>;

export const automationRunEffectKinds = [
  'integration_call',
  'message_delivery',
  'child_launch',
] as const;
export const automationRunEffectKindSchema = z.enum(automationRunEffectKinds);
export type AutomationRunEffectKind = z.infer<
  typeof automationRunEffectKindSchema
>;

export const automationRunEffectStatuses = [
  'executing',
  'succeeded',
  'failed',
] as const;
export const automationRunEffectStatusSchema = z.enum(
  automationRunEffectStatuses,
);
export type AutomationRunEffectStatus = z.infer<
  typeof automationRunEffectStatusSchema
>;

export const automationDeliveryTargetSchema = z.object({
  provider: communicationProviderSchema,
  channelId: z.string().min(1),
  teamId: z.string().min(1).optional(),
  serviceUrl: z.string().min(1).optional(),
});
export type AutomationDeliveryTarget = z.infer<
  typeof automationDeliveryTargetSchema
>;

export const fastAutomationReportingModes = [
  'required',
  'on_findings',
  'silent_allowed',
] as const;
export const fastAutomationChildKickoffModes = [
  'required',
  'silent_allowed',
] as const;

export const fastAutomationExecutionPolicySchema = z.object({
  version: z.number().int().positive(),
  reporting: z.enum(fastAutomationReportingModes),
  childKickoff: z.enum(fastAutomationChildKickoffModes),
});
export type FastAutomationExecutionPolicy = z.infer<
  typeof fastAutomationExecutionPolicySchema
>;

export const automationRunParentSchema = z.object({
  kind: z.literal('automation_run'),
  automationRunId: z.string().uuid(),
});
export type AutomationRunParent = z.infer<typeof automationRunParentSchema>;

export function getAutomationRunParentFromPayload(
  payload: unknown,
): AutomationRunParent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const parsed = z
    .object({ automationRunParent: automationRunParentSchema })
    .safeParse(payload);
  return parsed.success ? parsed.data.automationRunParent : null;
}
