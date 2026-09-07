import { getBackgroundAgentSettingsForDeployment } from '@roomote/db/server';
import { hasEnabledBackgroundAgents } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from './feature-gates';

export type AutomationOnboardingStatus = {
  hasEnabledAutomations: boolean;
};

/**
 * Minimal projection for the home onboarding nudge: only whether any
 * automation is enabled. Reads local rows and makes no Slack calls, so it can
 * sit on the dashboard's critical path (unlike the full settings read).
 */
export async function getAutomationOnboardingStatusCommand(
  auth: UserAuthSuccess,
): Promise<AutomationOnboardingStatus> {
  assertAdmin(auth);

  const settings = await getBackgroundAgentSettingsForDeployment();
  const {
    providerUsageLimitFrequency: _providerUsageLimitFrequency,
    ...userConfiguredAutomationSettings
  } = settings;

  return {
    hasEnabledAutomations: hasEnabledBackgroundAgents(
      userConfiguredAutomationSettings,
    ),
  };
}
