import type { MetadataBooleanDescriptor } from './types';

export const DEPLOYMENT_EXPERIMENT_IDS = [
  'privateSessions',
  'browserNotifications',
  'integrationToolAutoApprovals',
  'sessionTaskCommunicationTriage',
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
 * Every deployment experiment must choose its audience explicitly. Unknown
 * experiments are never treated as customer-visible by default.
 */
export const DEPLOYMENT_EXPERIMENT_AUDIENCE = {
  privateSessions: 'customer-preview',
  sessionTaskCommunicationTriage: 'customer-preview',
  browserNotifications: 'customer-preview',
  integrationToolAutoApprovals: 'customer-preview',
} as const satisfies Record<
  DeploymentExperimentId,
  DeploymentExperimentAudience
>;

export const DEPLOYMENT_EXPERIMENT_METADATA_KEYS = {
  privateSessions: 'private_sessions_experiment_enabled',
  browserNotifications: 'browser_notifications_experiment_enabled',
  integrationToolAutoApprovals:
    'integration_tool_auto_approvals_experiment_enabled',
  sessionTaskCommunicationTriage:
    'session_task_communication_triage_experiment_enabled',
} as const satisfies Record<DeploymentExperimentId, string>;

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
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.privateSessions]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Allow members to create owner-only private sessions. Disabled by default; absent means disabled.',
  },
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.browserNotifications]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Offer desktop browser notifications while the relevant session or task page remains open',
  },
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.integrationToolAutoApprovals]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Show the Auto-approval decisions card in Settings → Agent Guidance for admins to turn on.',
  },
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.sessionTaskCommunicationTriage]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Stream delegated task activity to its Session and let the judgment model decide whether to tell the user, redirect the task, or stay quiet. Disabled by default; absent means disabled.',
  },
};
