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

export const workspaceRoutingSettingsSchema = z.object({
  allRepositoriesRoutingRules: workspaceRoutingRulesSchema.default([]),
});

export type WorkspaceRoutingSettings = z.infer<
  typeof workspaceRoutingSettingsSchema
>;
