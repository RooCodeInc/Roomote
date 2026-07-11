import {
  FeatureFlag,
  type FeatureFlagConfigMap,
  type MetadataBooleanDescriptor,
} from './types';

/**
 * Centralized feature flag configuration
 * Defines default values and optional overrides for all feature flags
 */
export const FEATURE_FLAG_CONFIG: FeatureFlagConfigMap = {
  [FeatureFlag.PlanMode]: {
    name: 'Read-only planning',
    defaultValue: false,
    metadataKey: 'plan_mode',
    description:
      'On: planning stays read-only. Off: agents can continue from planning into implementation.',
  },
  [FeatureFlag.SlackEvalLauncher]: {
    name: 'Custom Slack task launches',
    defaultValue: false,
    metadataKey: 'slack_eval_launcher',
    description:
      'On: !eval launches Slack tasks with custom model, reasoning, and Git options. Off: the command reports that it is unavailable.',
  },
  [FeatureFlag.ShowDebugUISetting]: {
    name: 'Debug controls',
    defaultValue: false,
    metadataKey: 'show_debug_ui_setting',
    description:
      'On: users can enable troubleshooting details in Personal settings. Off: the debug option is hidden.',
  },

  [FeatureFlag.SlackProofAutoPost]: {
    name: 'Post visual proof to Slack',
    defaultValue: false,
    metadataKey: 'slack_proof_auto_post',
    description:
      'On: visual proof is posted to the Slack thread where the task started. Off: proof is not posted automatically.',
  },

  [FeatureFlag.SuggestionRouting]: {
    name: 'Grouped idea suggestions',
    defaultValue: false,
    metadataKey: 'suggestion_routing',
    description:
      'On: idea suggestions can be grouped across Slack channels, with a plan for each group. Off: all suggestions go to the manager channel.',
  },

  [FeatureFlag.VisualProofAutoScreencast]: {
    name: 'Automatic proof recordings',
    defaultValue: false,
    metadataKey: 'visual_proof_auto_screencast',
    description:
      'On: visual proof can automatically use recordings when screenshots are not enough. Off: automatic proof uses screenshots.',
  },

  [FeatureFlag.AuthorshipRules]: {
    name: 'Task authorship rules',
    defaultValue: () => process.env.NODE_ENV === 'development',
    metadataKey: 'authorship_rules',
    description:
      'On: workspace rules set task authors and pull request owners. Off: default attribution applies.',
  },

  [FeatureFlag.BackgroundSubagents]: {
    name: 'Background helper agents',
    // Off by default: proof capture runs foreground and before delivery, so
    // the judge pass and the PR ship with the screenshots already verified.
    // Background delivery proved unreliable in dogfood — models repeatedly
    // failed to use the Task tool's background flag — and the subagent
    // watchdog's inactivity deadline now bounds foreground capture cost.
    // The flag remains an opt-in for re-testing background behavior.
    defaultValue: false,
    metadataKey: 'background_subagents',
    legacyMetadataKeys: ['opencode_background_subagents'],
    description:
      'On: helper agents can run asynchronously, so pull requests may arrive before visual proof. Off: visual proof finishes before delivery.',
  },
};

/**
 * Non-feature-flag boolean deployment metadata that is still actively read in the
 * product and should be treated as first-class admin controls.
 */
export const DEPLOYMENT_METADATA_BOOLEAN_CONFIG: Record<
  string,
  MetadataBooleanDescriptor
> = {
  previews_enabled: {
    kind: 'deployment-control',
    group: null,
    description:
      'Allow human-facing live preview ports to publish when runtime preview infrastructure is configured',
  },
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
