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
      'Let agents create implementation plans without changing files.',
  },
  [FeatureFlag.SlackEvalLauncher]: {
    name: 'Custom Slack task launches',
    defaultValue: false,
    metadataKey: 'slack_eval_launcher',
    description:
      'Use !eval in Slack to launch tasks with a specific model, reasoning level, branch, or commit.',
  },
  [FeatureFlag.ShowDebugUISetting]: {
    name: 'Debug controls',
    defaultValue: false,
    metadataKey: 'show_debug_ui_setting',
    description:
      'Let users show additional troubleshooting information from Personal settings.',
  },

  [FeatureFlag.SlackProofAutoPost]: {
    name: 'Post visual proof to Slack',
    defaultValue: false,
    metadataKey: 'slack_proof_auto_post',
    description:
      'Post task screenshots and recordings to the Slack thread where the task started.',
  },

  [FeatureFlag.SuggestionRouting]: {
    name: 'Grouped idea suggestions',
    defaultValue: false,
    metadataKey: 'suggestion_routing',
    description:
      'Group Slack suggestions by destination and create a tailored plan for each group.',
  },

  [FeatureFlag.VisualProofAutoScreencast]: {
    name: 'Automatic proof recordings',
    defaultValue: false,
    metadataKey: 'visual_proof_auto_screencast',
    description:
      'Record a screencast when visual proof needs to show an interaction or change over time.',
  },

  [FeatureFlag.AuthorshipRules]: {
    name: 'Task authorship rules',
    defaultValue: () => process.env.NODE_ENV === 'development',
    metadataKey: 'authorship_rules',
    description:
      'Set task authors and pull request owners with workspace-wide rules.',
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
      'Let helper agents run asynchronously so pull requests can be delivered while visual proof is still being captured.',
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
