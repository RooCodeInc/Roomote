import { z } from 'zod';

export const MAX_WORKSPACE_ROUTING_RULES = 20;
export const MAX_WORKSPACE_ROUTING_RULE_LENGTH = 500;
export const MAX_WORKSPACE_ROUTING_GUIDANCE_LENGTH = 20_000;

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

export const legacyWorkspaceRoutingSettingsSchema = z.object({
  rules: z.array(workspaceRoutingEntrySchema).max(MAX_WORKSPACE_ROUTING_RULES),
});

export const workspaceRoutingSettingsSchema = z.object({
  guidance: z
    .string()
    .max(MAX_WORKSPACE_ROUTING_GUIDANCE_LENGTH)
    .transform((value) => value.trim()),
});

export type WorkspaceRoutingSettings = z.infer<
  typeof workspaceRoutingSettingsSchema
>;
export type LegacyWorkspaceRoutingSettings = z.infer<
  typeof legacyWorkspaceRoutingSettingsSchema
>;

/** Legacy rules remain for one release so N-1 code can still read the column. */
export type WorkspaceRoutingSettingsStorage =
  | LegacyWorkspaceRoutingSettings
  | (WorkspaceRoutingSettings & LegacyWorkspaceRoutingSettings);
