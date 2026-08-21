import {
  applySetupAutomationRecommendations,
  dismissSetupAutomationRecommendations,
  listSetupAutomationRecommendations,
  prefetchSetupAutomationRecommendationSignals,
  runSetupAutomationRecommendationNow,
  setSetupAutomationRecommendationEnabled,
  skipSetupAutomationRecommendations,
  startSetupAutomationRecommendations,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { assertAdmin } from '../setup/shared';
import { triggerAutomationCommand } from '../automations/trigger-agent';
import { triggerCustomAutomationCommand } from '../automations/custom-automations';

export async function prefetchSetupRecommendationSignalsCommand(
  auth: UserAuthSuccess,
  _input: { repositoryIds: string[] },
) {
  assertAdmin(auth);
  return prefetchSetupAutomationRecommendationSignals();
}

export async function setSetupRecommendationEnabledCommand(
  auth: UserAuthSuccess,
  input: { id: string; enabled: boolean },
) {
  assertAdmin(auth);
  return setSetupAutomationRecommendationEnabled({
    userId: auth.userId,
    ...input,
  });
}

export async function applySetupRecommendationsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  return applySetupAutomationRecommendations(auth.userId);
}

export async function skipSetupRecommendationsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  return skipSetupAutomationRecommendations();
}

export async function listSetupRecommendationsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  return listSetupAutomationRecommendations();
}

export async function startSetupRecommendationsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  return startSetupAutomationRecommendations();
}

export async function runSetupRecommendationNowCommand(
  auth: UserAuthSuccess,
  input: { id: string },
) {
  assertAdmin(auth);
  return runSetupAutomationRecommendationNow({
    userId: auth.userId,
    id: input.id,
    runBuiltIn: (automationKey) =>
      triggerAutomationCommand(auth, { automationKey }),
    runCustom: (id) => triggerCustomAutomationCommand(auth, { id }),
  });
}

export async function dismissSetupRecommendationsCardCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  return dismissSetupAutomationRecommendations();
}
