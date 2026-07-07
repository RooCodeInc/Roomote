import { z } from 'zod';

import { workspaceReadinessSchema } from '@roomote/types';

const automationWorkItemBaseSchema = z.object({
  title: z.string().trim().min(1).max(140),
  brief: z.string().trim().min(1).max(2000),
  category: z
    .enum(['bug', 'security', 'chore', 'feature', 'improvement'])
    .optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  actionKind: z.string().trim().min(1).max(120),
  investigationContext: z.string().trim().max(4000).optional(),
  fingerprint: z.string().trim().max(255).optional(),
  targetEnvironmentId: z.string().uuid().optional(),
  workspaceReadiness: workspaceReadinessSchema.optional(),
  readinessMessage: z.string().trim().min(1).max(500).optional(),
});

export const automationWorkItemSchema = z
  .discriminatedUnion('disposition', [
    automationWorkItemBaseSchema.extend({
      disposition: z.literal('suggest'),
      executionPrompt: z.string().trim().max(6000).optional(),
      targetRepositoryFullName: z.string().trim().min(1).optional(),
    }),
    automationWorkItemBaseSchema.extend({
      disposition: z.literal('act'),
      executionPrompt: z
        .string({
          required_error:
            'Act automation work items must include executionPrompt.',
        })
        .trim()
        .min(1, 'Act automation work items must include executionPrompt.')
        .max(6000),
      targetRepositoryFullName: z
        .string({
          required_error:
            'Act automation work items must include targetRepositoryFullName.',
        })
        .trim()
        .min(
          1,
          'Act automation work items must include targetRepositoryFullName.',
        ),
    }),
  ])
  .superRefine((workItem, ctx) => {
    if (workItem.disposition === 'act' && !workItem.targetEnvironmentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetEnvironmentId'],
        message: 'Act automation work items must include targetEnvironmentId.',
      });
    }

    if (
      !workItem.targetRepositoryFullName?.trim() &&
      (workItem.targetEnvironmentId ||
        workItem.workspaceReadiness ||
        workItem.readinessMessage)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetRepositoryFullName'],
        message:
          'Automation work items must include targetRepositoryFullName when launch metadata is provided.',
      });
    }
  });

export const submitAutomationWorkItemsBodySchema = z.object({
  workItems: z.array(automationWorkItemSchema).max(5),
});

export type AutomationWorkItemInput = z.infer<typeof automationWorkItemSchema>;
