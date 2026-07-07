import { z } from 'zod';
import { deploymentEnvVarNameSchema } from '@roomote/types';

export const createEnvVarSchema = z.object({
  name: deploymentEnvVarNameSchema,
  value: z.string().min(1, 'Value is required'),
});

export type CreateEnvVar = z.infer<typeof createEnvVarSchema>;

export const updateEnvVarSchema = z.object({
  value: z.string().min(1, 'Value is required'),
});

export type UpdateEnvVar = z.infer<typeof updateEnvVarSchema>;
