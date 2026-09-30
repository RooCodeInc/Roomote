'use client';

import type { ComponentType } from 'react';

import type {
  DeploymentExperimentAudience,
  DeploymentExperimentId,
} from '@roomote/feature-flags';
import { getDeploymentExperimentAudience } from '@roomote/feature-flags';

import { BrowserNotificationsExperimentalSetting } from './BrowserNotificationsExperimentalSetting';
import { JevgrepExperimentalSetting } from './JevgrepExperimentalSetting';
import { AutomationLaunchCriteriaExperimentalSetting } from './AutomationLaunchCriteriaExperimentalSetting';
import { PrivateSessionsExperimentalSetting } from './PrivateSessionsExperimentalSetting';
import { SessionTaskCommunicationTriageExperimentalSetting } from './SessionTaskCommunicationTriageExperimentalSetting';

const DEPLOYMENT_EXPERIMENT_SETTINGS: Record<
  DeploymentExperimentId,
  ComponentType | null
> = {
  jevgrep: JevgrepExperimentalSetting,
  privateSessions: PrivateSessionsExperimentalSetting,
  sessionTaskCommunicationTriage:
    SessionTaskCommunicationTriageExperimentalSetting,
  browserNotifications: BrowserNotificationsExperimentalSetting,
  // The Auto tool approvals control was deliberately removed in PR #3180.
  integrationToolAutoApprovals: null,
  automationLaunchCriteria: AutomationLaunchCriteriaExperimentalSetting,
};

export function getExperimentSettingIds(
  audience: DeploymentExperimentAudience,
): DeploymentExperimentId[] {
  return (
    Object.keys(DEPLOYMENT_EXPERIMENT_SETTINGS) as DeploymentExperimentId[]
  ).filter(
    (id) =>
      DEPLOYMENT_EXPERIMENT_SETTINGS[id] !== null &&
      getDeploymentExperimentAudience(id) === audience,
  );
}

export function ExperimentSettingsControls({
  audience,
}: {
  audience: DeploymentExperimentAudience;
}) {
  return (
    <>
      {getExperimentSettingIds(audience).map((id) => {
        const Setting = DEPLOYMENT_EXPERIMENT_SETTINGS[id];
        return Setting ? <Setting key={id} /> : null;
      })}
    </>
  );
}
