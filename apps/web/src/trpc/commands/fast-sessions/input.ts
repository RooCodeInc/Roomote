import { z } from 'zod';

import { REASONING_EFFORT_VALUES } from '@roomote/types';

const MAX_FAST_ATTACHMENT_COUNT = 20;
const MAX_FAST_ATTACHMENT_TEXT_CHARS = 200_000;

const fastSessionMessageInputShape = {
  text: z.string().trim(),
  images: z
    .array(
      z
        .string()
        .trim()
        .regex(
          /^data:(image\/[^;,]+);base64,(.+)$/i,
          'Image must be a base64 data URL',
        ),
    )
    .optional(),
  attachmentTexts: z
    .array(z.string().trim().min(1))
    .max(MAX_FAST_ATTACHMENT_COUNT)
    .optional(),
  model: z.string().trim().min(1).nullable().optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).nullable().optional(),
};

function requireFastSessionContent(
  input: { text: string; images?: string[]; attachmentTexts?: string[] },
  ctx: z.RefinementCtx,
): void {
  if (!input.text && !input.images?.length && !input.attachmentTexts?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Text or at least one attachment is required',
      path: ['text'],
    });
  }

  const attachmentTextChars = (input.attachmentTexts ?? []).reduce(
    (total, attachmentText) => total + attachmentText.length,
    0,
  );
  if (attachmentTextChars > MAX_FAST_ATTACHMENT_TEXT_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Extracted attachment text exceeds the 200,000 character limit',
      path: ['attachmentTexts'],
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

export const fastSessionPrReviewActionInputSchema = z.object({
  sessionId: z.string().uuid(),
  deliveryId: z.string().uuid(),
  choice: z.enum(['yes', 'auto', 'dismiss']),
});

export const updateFastSessionModelSelectionInputSchema = z.object({
  sessionId: z.string().uuid(),
  model: fastSessionMessageInputShape.model,
  reasoningEffort: fastSessionMessageInputShape.reasoningEffort,
});
