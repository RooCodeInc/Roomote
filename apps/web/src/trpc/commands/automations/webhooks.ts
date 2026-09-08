import {
  configureAutomationWebhook,
  getAutomationWebhook,
  removeAutomationWebhook,
  retryAutomationWebhookDelivery,
} from '@roomote/sdk/server';
import type { automationWebhookConfigSchema } from '@roomote/types';
import type { z } from 'zod';

import type { UserAuthSuccess } from '@/types';

export async function getAutomationWebhookCommand(
  auth: UserAuthSuccess,
  input: { automationId: string },
) {
  return getAutomationWebhook(auth.userId, input.automationId);
}

export async function configureAutomationWebhookCommand(
  auth: UserAuthSuccess,
  input: {
    automationId: string;
    config: z.infer<typeof automationWebhookConfigSchema>;
  },
) {
  return configureAutomationWebhook(
    auth.userId,
    input.automationId,
    input.config,
  );
}

export async function removeAutomationWebhookCommand(
  auth: UserAuthSuccess,
  input: { automationId: string; forceLocalRemoval?: boolean },
) {
  return removeAutomationWebhook(
    auth.userId,
    input.automationId,
    input.forceLocalRemoval,
  );
}

export async function retryAutomationWebhookDeliveryCommand(
  auth: UserAuthSuccess,
  input: { automationId: string; deliveryId: string },
) {
  return retryAutomationWebhookDelivery(
    auth.userId,
    input.automationId,
    input.deliveryId,
  );
}
