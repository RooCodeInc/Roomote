import { z } from 'zod';

import { ALL_REPOSITORIES } from './constants';

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

export function normalizeWorkspaceRoutingSettings(
  value: unknown,
  environmentNames: ReadonlyMap<string, string> = new Map(),
): WorkspaceRoutingSettings {
  const current = workspaceRoutingSettingsSchema.safeParse(value);
  if (current.success) return current.data;

  const legacy = legacyWorkspaceRoutingSettingsSchema.parse(value);
  return {
    guidance: legacy.rules
      .map((rule) => {
        const target =
          rule.target === ALL_REPOSITORIES
            ? 'All repositories'
            : environmentNames.get(rule.target)
              ? `the "${environmentNames.get(rule.target)}" environment`
              : `environment "${rule.target}"`;
        return `- ${rule.description} -> Use ${target}.`;
      })
      .join('\n'),
  };
}
