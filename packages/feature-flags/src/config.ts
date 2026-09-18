import type { MetadataBooleanDescriptor } from './types';

export const DEPLOYMENT_EXPERIMENT_IDS = [
  'results',
  'slackPeerConversations',
  'serviceCredentialTools',
  'privateSessions',
  'browserNotifications',
  'toolApprovals',
] as const;

export type DeploymentExperimentId = (typeof DEPLOYMENT_EXPERIMENT_IDS)[number];

export const DEPLOYMENT_EXPERIMENT_METADATA_KEYS = {
  results: 'results_page_enabled',
  slackPeerConversations: 'slack_peer_conversations_experiment_enabled',
  serviceCredentialTools: 'integration_keys_enabled',
  privateSessions: 'private_sessions_experiment_enabled',
  browserNotifications: 'browser_notifications_experiment_enabled',
  toolApprovals: 'tool_approvals_experiment_enabled',
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
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.slackPeerConversations]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Allow Fast to observe human-to-human discussion in established Slack and Discord threads',
  },
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.serviceCredentialTools]: {
    kind: 'deployment-control',
    group: null,
    description: 'Allow members to use approved integration keys',
  },
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.privateSessions]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Allow members to create owner-only private Sessions. Disabled by default; absent means disabled.',
  },
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.browserNotifications]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Offer desktop browser notifications while the relevant Session or task page remains open',
  },
  [DEPLOYMENT_EXPERIMENT_METADATA_KEYS.toolApprovals]: {
    kind: 'deployment-control',
    group: null,
    description:
      'Ask the Session requester to allow or reject each on-demand integration tool call before it runs. Disabled by default; absent means disabled.',
  },
};
