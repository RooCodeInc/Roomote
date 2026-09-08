import { z } from 'zod';

import { getCommunicationAutomationTargetKind } from './background-agents';

export const ciFailureTriageRepositoryRoutesSchema = z
  .array(
    z.object({
      repositoryIds: z.array(z.string().uuid()).min(1),
      target: z
        .object({
          provider: z.enum(['slack', 'discord', 'teams', 'telegram']),
          targetKind: z.enum([
            'slack_channel',
            'discord_channel',
            'teams_channel',
            'telegram_chat',
          ]),
          externalRef: z.string().trim().min(1).max(500),
          metadata: z.record(z.unknown()).optional(),
        })
        .refine(
          (target) =>
            target.targetKind ===
            getCommunicationAutomationTargetKind(target.provider, 'channel'),
          'Destination kind must match its provider.',
        ),
    }),
  )
  .superRefine((routes, ctx) => {
    const seen = new Set<string>();
    for (const [index, route] of routes.entries()) {
      for (const id of route.repositoryIds) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'repositoryIds'],
            message: 'Each repository can belong to only one route group.',
          });
        }
        seen.add(id);
      }
    }
  });

export type CiFailureTriageRepositoryRoute = z.infer<
  typeof ciFailureTriageRepositoryRoutesSchema
>[number];

/** Missing config is legacy all-repository routing; invalid config fails closed. */
export function getCiFailureTriageRepositoryRoutes(
  settings: Record<string, unknown> = {},
): CiFailureTriageRepositoryRoute[] | undefined {
  if (settings.repositoryRoutes === undefined) return undefined;
  const parsed = ciFailureTriageRepositoryRoutesSchema.safeParse(
    settings.repositoryRoutes,
  );
  return parsed.success ? parsed.data : [];
}
