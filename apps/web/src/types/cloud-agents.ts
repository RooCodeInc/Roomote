import { z } from 'zod';
import { stripHtml } from 'string-strip-html';

export const createTaskFormSchema = z.object({
  repository: z.string().min(1, 'Repository is required.'),
  branch: z.string().optional(),
  environmentId: z.string().uuid().optional(),
  text: z
    .string()
    .min(1, 'Message is required.')
    .refine((val) => stripHtml(val).result.trim().length > 0, {
      message: 'Message is required.',
    }),
  images: z.array(z.string()).optional(),
  port: z
    .number()
    .int()
    .min(1024, 'Port must be at least 1024.')
    .max(65535, 'Port must be at most 65535.')
    .optional(),
});

export type CreateTaskFormValues = z.infer<typeof createTaskFormSchema>;
