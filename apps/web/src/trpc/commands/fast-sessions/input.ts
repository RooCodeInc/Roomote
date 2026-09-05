import { z } from 'zod';

import {
  computeProviders,
  launchCodingHarnesses,
  REASONING_EFFORT_VALUES,
} from '@roomote/types';

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

/**
 * A launch whose workspace the person already chose. The Session records the
 * request and delegates the task immediately instead of asking Fast to decide.
 * When present, the top-level `model` selects the task model, and an empty
 * prompt opens a blank workspace.
 */
export const pinnedFastSessionLaunchSchema = z.object({
  launchId: z.string().uuid(),
  repo: z.string().trim().min(1),
  branch: z.string().trim().min(1).optional(),
  sha: z.string().trim().min(1).optional(),
  environmentId: z.string().uuid().optional(),
  harness: z.enum(launchCodingHarnesses).optional(),
  computeProvider: z.enum(computeProviders).optional(),
});

export type PinnedFastSessionLaunchInput = z.infer<
  typeof pinnedFastSessionLaunchSchema
>;

function requireFastSessionContent(
  input: {
    text: string;
    images?: string[];
    attachmentTexts?: string[];
    pinnedLaunch?: unknown;
    empty?: true;
  },
  ctx: z.RefinementCtx,
): void {
  // A pinned launch may open a blank workspace with nothing to say yet.
  if (input.pinnedLaunch) {
    return;
  }
  if (input.empty) {
    if (input.text || input.images?.length || input.attachmentTexts?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An empty session cannot include message content',
        path: ['empty'],
      });
    }
    return;
  }
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
  .object({
    ...fastSessionMessageInputShape,
    conversationId: z.string().uuid().optional(),
    empty: z.literal(true).optional(),
    pinnedLaunch: pinnedFastSessionLaunchSchema.optional(),
  })
  .superRefine((input, ctx) => {
    requireFastSessionContent(input, ctx);
    if (input.empty && !input.conversationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Empty session starts require a conversation ID',
        path: ['conversationId'],
      });
    }
  });

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
