import { z } from 'zod';

export const automationAdditionalRulesSchema = z
  .object({
    text: z.string().min(1).max(8000),
    repositoryIds: z.array(z.string().uuid()).nullable(),
    destinations: z.array(
      z
        .object({
          repositoryId: z.string().uuid(),
          target: z
            .object({
              provider: z.enum(['slack', 'discord', 'teams', 'telegram']),
              externalRef: z.string().min(1),
              workspaceId: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    ),
    instructions: z.string(),
  })
  .strict()
  .superRefine((rules, ctx) => {
    const ids = rules.repositoryIds;
    const destinations = rules.destinations.map((entry) => entry.repositoryId);
    if (
      (ids && new Set(ids).size !== ids.length) ||
      new Set(destinations).size !== destinations.length ||
      (ids && destinations.some((id) => !ids.includes(id)))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Repository rules must be unique and destinations must be in scope.',
      });
    }
  });

export type AutomationAdditionalRules = z.infer<
  typeof automationAdditionalRulesSchema
>;

/** undefined preserves the shipped default; null is invalid and must fail closed. */
export function getAutomationAdditionalRules(
  settings: Record<string, unknown> = {},
): AutomationAdditionalRules | null | undefined {
  const text = settings.additionalRules;
  if (text === undefined || text === '') return undefined;
  if (typeof text !== 'string') return null;
  const parsed = automationAdditionalRulesSchema.safeParse(
    settings.compiledRules,
  );
  return parsed.success && parsed.data.text === text ? parsed.data : null;
}

export function isAutomationAdditionalRulesRepositoryAllowed(
  settings: Record<string, unknown> | undefined,
  repositoryId: string,
): boolean {
  const rules = getAutomationAdditionalRules(settings);
  return (
    rules !== null &&
    (rules?.repositoryIds == null || rules.repositoryIds.includes(repositoryId))
  );
}
