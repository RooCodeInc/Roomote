import { z } from 'zod';

export const MAX_WORKSPACE_ROUTING_RULES = 20;
export const MAX_WORKSPACE_ROUTING_RULE_LENGTH = 500;

export const workspaceRoutingRuleSchema = z
  .string()
  .trim()
  .min(1, 'Routing rules cannot be empty.')
  .max(MAX_WORKSPACE_ROUTING_RULE_LENGTH);

export const workspaceRoutingRulesSchema = z
  .array(workspaceRoutingRuleSchema)
  .max(MAX_WORKSPACE_ROUTING_RULES);

export const workspaceRoutingEntrySchema = z.object({
  description: workspaceRoutingRuleSchema,
  target: z.string().trim().min(1),
});

export const workspaceRoutingSettingsSchema = z.object({
  rules: z.array(workspaceRoutingEntrySchema).max(MAX_WORKSPACE_ROUTING_RULES),
});

export type WorkspaceRoutingSettings = z.infer<
  typeof workspaceRoutingSettingsSchema
>;
