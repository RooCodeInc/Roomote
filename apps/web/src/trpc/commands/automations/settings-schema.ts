import { z } from 'zod';

export const mergeAnnouncerDestinationInputSchema = z.object({
  mergeAnnouncerTargetProvider: z
    .enum(['slack', 'teams', 'telegram', 'discord'])
    .nullable()
    .optional(),
  mergeAnnouncerTargetMode: z.enum(['channel', 'direct_message']).optional(),
  mergeAnnouncerTargetChannelId: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .nullable()
    .optional(),
});

export const mergeAnnouncerDestinationInputShape =
  mergeAnnouncerDestinationInputSchema.shape;
