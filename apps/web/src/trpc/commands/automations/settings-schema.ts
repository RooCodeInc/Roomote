import { z } from 'zod';

function buildAutomationDestinationInputSchema(prefix: string) {
  return z.object({
    [`${prefix}TargetProvider`]: z
      .enum(['slack', 'teams', 'telegram', 'discord'])
      .nullable()
      .optional(),
    [`${prefix}TargetMode`]: z.enum(['channel', 'direct_message']).optional(),
    [`${prefix}TargetChannelId`]: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .nullable()
      .optional(),
  });
}

export const mergeAnnouncerDestinationInputSchema =
  buildAutomationDestinationInputSchema('mergeAnnouncer');

export const mergeAnnouncerDestinationInputShape =
  mergeAnnouncerDestinationInputSchema.shape;

const releaseAnnouncementsDestinationInputSchema =
  buildAutomationDestinationInputSchema('releaseAnnouncements');
export const releaseAnnouncementsDestinationInputShape =
  releaseAnnouncementsDestinationInputSchema.shape;
