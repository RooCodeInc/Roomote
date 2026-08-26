import type { FeatureFlagConfigMap, MetadataBooleanDescriptor } from './types';

export const FEATURE_FLAG_CONFIG: FeatureFlagConfigMap = {
  sessions_data: {
    defaultValue: false,
    metadataKey: 'sessions_data',
    description: 'Create and reconcile unified Session records',
    group: 'Sessions',
  },
  sessions_ui: {
    defaultValue: false,
    metadataKey: 'sessions_ui',
    description: 'Use Sessions as the primary dashboard navigation unit',
    group: 'Sessions',
  },
  sessions_comms: {
    defaultValue: false,
    metadataKey: 'sessions_comms',
    description: 'Use Session-aware communication wording and links',
    group: 'Sessions',
  },
};

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
};
