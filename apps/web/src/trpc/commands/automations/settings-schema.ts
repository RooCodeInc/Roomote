import { z } from 'zod';
import { AUTOMATION_DESTINATION_DESCRIPTORS } from '@roomote/types';

export const automationEmailDestinationInputShape = Object.fromEntries(
  AUTOMATION_DESTINATION_DESCRIPTORS.map((descriptor) => [
    descriptor.emailField,
    z.string().trim().min(1).max(255).nullable().optional(),
  ]),
);

function buildAutomationDestinationInputSchema(prefix: string) {
  return z.object({
    [`${prefix}TargetProvider`]: z
      .enum(['slack', 'teams', 'telegram', 'discord', 'email'])
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
