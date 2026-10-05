import { randomBytes } from 'node:crypto';

import {
  getAutomationByKey,
  getBackgroundAutomationWebhookState,
  ensureBackgroundAutomationWebhookToken,
  rotateBackgroundAutomationWebhookToken,
  setBackgroundAutomationWebhookToken,
} from '@roomote/db/server';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  isBuiltInWebhookAutomationKey,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';

import { Env } from '@/lib/server/env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from './feature-gates';

function assertWebhookKey(
  automationKey: TriggerableBackgroundAutomationKey,
): void {
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);
  if (!descriptor || !isBuiltInWebhookAutomationKey(automationKey)) {
    throw new Error('This built-in automation does not support webhooks.');
  }
}

function buildBuiltInAutomationWebhookUrl(
  automationKey: TriggerableBackgroundAutomationKey,
  token: string,
): string {
  return new URL(
    `/api/webhooks/built-in-automations/${automationKey}/${token}`,
    getPublicAppUrl(Env),
  ).toString();
}

async function assertEnabledAutomation(
  automationKey: TriggerableBackgroundAutomationKey,
) {
  const automation = await getAutomationByKey(automationKey);
  if (!automation?.enabled) {
    throw new Error('Enable the automation before enabling its webhook.');
  }
  return automation;
}

export async function getBuiltInAutomationWebhookCommand(
  auth: UserAuthSuccess,
  input: { automationKey: TriggerableBackgroundAutomationKey },
): Promise<{ enabled: boolean; url: string | null }> {
  assertAdmin(auth);
  assertWebhookKey(input.automationKey);
  const webhook = await getBackgroundAutomationWebhookState(
    input.automationKey,
  );
  if (!webhook?.enabled || !webhook.token) {
    return { enabled: false, url: null };
  }
  return {
    enabled: true,
    url: buildBuiltInAutomationWebhookUrl(input.automationKey, webhook.token),
  };
}

export async function setBuiltInAutomationWebhookEnabledCommand(
  auth: UserAuthSuccess,
  input: {
    automationKey: TriggerableBackgroundAutomationKey;
    enabled: boolean;
  },
): Promise<{ enabled: boolean; url: string | null }> {
  assertAdmin(auth);
  assertWebhookKey(input.automationKey);
  if (!input.enabled) {
    if (
      !(await setBackgroundAutomationWebhookToken(input.automationKey, null))
    ) {
      throw new Error('Built-in automation was not found.');
    }
    return { enabled: false, url: null };
  }

  await assertEnabledAutomation(input.automationKey);
  const token = await ensureBackgroundAutomationWebhookToken(
    input.automationKey,
    randomBytes(32).toString('base64url'),
  );
  if (!token) {
    throw new Error('Built-in automation was not found.');
  }
  return {
    enabled: true,
    url: buildBuiltInAutomationWebhookUrl(input.automationKey, token),
  };
}

export async function rotateBuiltInAutomationWebhookCommand(
  auth: UserAuthSuccess,
  input: { automationKey: TriggerableBackgroundAutomationKey },
): Promise<{ enabled: true; url: string }> {
  assertAdmin(auth);
  assertWebhookKey(input.automationKey);
  await assertEnabledAutomation(input.automationKey);
  const token = await rotateBackgroundAutomationWebhookToken(
    input.automationKey,
    randomBytes(32).toString('base64url'),
  );
  if (!token) {
    throw new Error(
      'Webhook is no longer enabled. Refresh settings and try again.',
    );
  }
  return {
    enabled: true,
    url: buildBuiltInAutomationWebhookUrl(input.automationKey, token),
  };
}
