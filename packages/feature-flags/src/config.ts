import type { MetadataBooleanDescriptor } from './types';

export const DEPLOYMENT_EXPERIMENT_IDS = [
  'privateSessions',
  'browserNotifications',
  'integrationToolAutoApprovals',
  'sessionTaskCommunicationTriage',
  'dizzy',
  'automationLaunchCriteria',
] as const;

export type DeploymentExperimentId = (typeof DEPLOYMENT_EXPERIMENT_IDS)[number];

export const DEPLOYMENT_EXPERIMENT_AUDIENCES = [
  'internal-nightly',
  'customer-preview',
  'generally-available',
] as const;

export type DeploymentExperimentAudience =
  (typeof DEPLOYMENT_EXPERIMENT_AUDIENCES)[number];

/**
 * Every deployment experiment owns its audience, persisted metadata key, and
 * optional member-readable runtime surface in one descriptor. Unknown
 * experiments are never treated as customer-visible by default.
 */
export type DeploymentExperimentDescriptor = {
  audience: DeploymentExperimentAudience;
  metadataKey: string;
  runtimeReadable?: boolean;
};

export const DEPLOYMENT_EXPERIMENT_CONFIG = {
  privateSessions: {
    audience: 'customer-preview',
    metadataKey: 'private_sessions_experiment_enabled',
  },
  sessionTaskCommunicationTriage: {
    audience: 'customer-preview',
    metadataKey: 'session_task_communication_triage_experiment_enabled',
  },
  browserNotifications: {
    audience: 'customer-preview',
    metadataKey: 'browser_notifications_experiment_enabled',
  },
  integrationToolAutoApprovals: {
    audience: 'internal-nightly',
    // A new key deliberately leaves former customer-preview opt-ins dormant.
    metadataKey: 'integration_tool_auto_approvals_nightly_experiment_enabled',
    runtimeReadable: true,
  },
  dizzy: {
    audience: 'internal-nightly',
    metadataKey: 'dizzy_experiment_enabled',
    runtimeReadable: true,
  },
  automationLaunchCriteria: {
    audience: 'internal-nightly',
    metadataKey: 'automation_launch_criteria_experiment_enabled',
  },
} as const satisfies Record<
  DeploymentExperimentId,
  DeploymentExperimentDescriptor
>;

export type DeploymentExperimentRuntimeId = {
  [Id in DeploymentExperimentId]: (typeof DEPLOYMENT_EXPERIMENT_CONFIG)[Id] extends {
    audience: 'internal-nightly';
    runtimeReadable: true;
  }
    ? Id
    : never;
}[DeploymentExperimentId];

export type DeploymentExperimentValues = Record<
  DeploymentExperimentId,
  boolean
>;

/**
 * Non-feature-flag boolean deployment metadata that is still actively read in
 * the product and should be treated as first-class admin controls.
 */
export const DEPLOYMENT_METADATA_BOOLEAN_CONFIG: Record<
  string,
  MetadataBooleanDescriptor
> = {
  deployment_disabled: {
    kind: 'deployment-control',
    group: null,
    description:
      'Disable Roomote access and new task launches for this deployment',
  },
  anonymous_analytics_enabled: {
    kind: 'deployment-control',
    group: null,
    description:
      'Share anonymous usage analytics (instance and user activity identified only by random IDs) with the Roomote team. Enabled by default; absent means enabled.',
  },
  [DEPLOYMENT_EXPERIMENT_CONFIG.privateSessions.metadataKey]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Allow members to create owner-only private sessions. Disabled by default; absent means disabled.',
  },
  [DEPLOYMENT_EXPERIMENT_CONFIG.browserNotifications.metadataKey]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Offer desktop browser notifications while the relevant session or task page remains open',
  },
  [DEPLOYMENT_EXPERIMENT_CONFIG.integrationToolAutoApprovals.metadataKey]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Show the Auto-approval decisions card in Settings → Agent Guidance for admins on internal nightly deployments.',
  },
  [DEPLOYMENT_EXPERIMENT_CONFIG.sessionTaskCommunicationTriage.metadataKey]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Stream delegated task activity to its Session and let the judgment model decide whether to tell the user, redirect the task, or stay quiet. Disabled by default; absent means disabled.',
  },
  [DEPLOYMENT_EXPERIMENT_CONFIG.automationLaunchCriteria.metadataKey]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Allow internal-nightly deployments to use plain-language and typed checks before custom automation work starts. Disabled by default; absent means disabled.',
  },
};
