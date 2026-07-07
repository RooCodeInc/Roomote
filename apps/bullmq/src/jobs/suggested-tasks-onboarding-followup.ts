import { Job } from 'bullmq';
import { z } from 'zod';

import { getBackgroundAgentSettingsForDeployment } from '@roomote/db/server';
import { Env } from '@roomote/env';

/**
 * Shared skeleton for the per-surface suggested-tasks onboarding follow-up
 * jobs: validate the payload, skip when the suggester automation is already
 * enabled, then hand delivery to the surface-specific sender. Invalid
 * payloads are logged and skipped instead of retried because they can never
 * become valid.
 */
export async function runSuggestedTasksOnboardingFollowupJob<
  Schema extends z.ZodTypeAny,
>({
  job,
  label,
  requestSchema,
  send,
}: {
  job: Job;
  label: string;
  requestSchema: Schema;
  send: (request: z.infer<Schema>) => Promise<void>;
}): Promise<void> {
  const parsed = requestSchema.safeParse(job.data);

  if (!parsed.success) {
    console.warn(`[${label}] Invalid job payload for job ${job.id}, skipping`);
    return;
  }

  const settings = await getBackgroundAgentSettingsForDeployment();

  if (settings.suggesterFrequency !== 'off') {
    console.log(`[${label}] Suggester already enabled, skipping follow-up`);
    return;
  }

  await send(parsed.data);
}

/**
 * Deep link to the suggester section of Automations, matching across every
 * follow-up surface. Non-Slack surfaces tag the link with UTM parameters
 * because their messages have no other attribution channel.
 */
export function buildSuggestedTasksSettingsUrl(utm?: {
  source: string;
  campaign: string;
}): string {
  const url = new URL('/automations', Env.ROOMOTE_APP_URL);

  if (utm) {
    url.searchParams.set('utm_source', utm.source);
    url.searchParams.set('utm_medium', 'link');
    url.searchParams.set('utm_campaign', utm.campaign);
  }

  url.hash = 'suggest-ideas';

  return url.toString();
}
