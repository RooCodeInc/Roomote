import { z } from 'zod';

import { REASONING_EFFORT_VALUES } from '@roomote/types';

const fastSessionMessageInputShape = {
  text: z.string().trim(),
  images: z.array(z.string()).optional(),
  model: z.string().trim().min(1).nullable().optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).nullable().optional(),
};

function requireFastSessionContent(
  input: { text: string; images?: string[] },
  ctx: z.RefinementCtx,
): void {
  if (!input.text && !input.images?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Text or at least one image is required',
      path: ['text'],
    });
  }
}

export const startFastSessionInputSchema = z
  .object(fastSessionMessageInputShape)
  .superRefine(requireFastSessionContent);

export const replyToFastSessionInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    ...fastSessionMessageInputShape,
  })
  .superRefine(requireFastSessionContent);
