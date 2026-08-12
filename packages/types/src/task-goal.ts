import { z } from 'zod';

export const TASK_GOAL_STATUSES = [
  'active',
  'complete',
  'blocked',
  'budget_limited',
] as const;

export type TaskGoalStatus = (typeof TASK_GOAL_STATUSES)[number];

export const DEFAULT_TASK_GOAL_MAX_CONTINUATIONS = 5;

export const taskGoalInputSchema = z.object({
  objective: z.string().trim().min(1).max(10_000),
  maxContinuations: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(DEFAULT_TASK_GOAL_MAX_CONTINUATIONS),
});

export type TaskGoalInput = z.infer<typeof taskGoalInputSchema>;

export const taskGoalSchema = taskGoalInputSchema.extend({
  generation: z.string().nullable(),
  status: z.enum(TASK_GOAL_STATUSES),
  continuationsUsed: z.number().int().min(0),
  blockedReason: z.string().nullable(),
  completedAt: z.coerce.date().nullable(),
});

export type TaskGoal = z.infer<typeof taskGoalSchema>;
