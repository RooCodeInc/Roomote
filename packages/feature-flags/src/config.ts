import type { MetadataBooleanDescriptor } from './types';

export const DEPLOYMENT_EXPERIMENT_IDS = [
  'results',
  'privateSessions',
  'browserNotifications',
  'integrationToolApprovals',
  'sessionTaskCommunicationTriage',
] as const;

export type DeploymentExperimentId = (typeof DEPLOYMENT_EXPERIMENT_IDS)[number];

export const DEPLOYMENT_EXPERIMENT_METADATA_KEYS = {
  results: 'results_page_enabled',
  privateSessions: 'private_sessions_experiment_enabled',
  browserNotifications: 'browser_notifications_experiment_enabled',
  integrationToolApprovals: 'integration_tool_approvals_experiment_enabled',
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
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.results]: {
    kind: 'deployment-control',
    group: null,
    description: 'Show the Results inbox to every member',
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
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.integrationToolApprovals]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Choose which integration tools run automatically, ask for approval, or are disabled. Tools left on Auto can use a judgement model to decide when to ask.',
  },
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.sessionTaskCommunicationTriage]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Stream delegated task activity to its Session and let the judgment model decide whether to tell the user, redirect the task, or stay quiet. Disabled by default; absent means disabled.',
  },
};
