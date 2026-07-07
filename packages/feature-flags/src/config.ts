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
    defaultValue: false,
    metadataKey: 'plan_mode',
    description: 'Enable plan mode, which keeps planning turns read-only',
  },
  [FeatureFlag.SlackEvalLauncher]: {
    defaultValue: false,
    metadataKey: 'slack_eval_launcher',
    description:
      'Enable the internal-only Slack `!eval` launcher for regular task launches with model, reasoning, and branch or SHA overrides',
  },
  [FeatureFlag.ShowDebugUISetting]: {
    defaultValue: false,
    metadataKey: 'show_debug_ui_setting',
    description:
      'Show the internal-only Personal Settings toggle for the user-level debug UI preference',
  },

  [FeatureFlag.SlackProofAutoPost]: {
    defaultValue: false,
    metadataKey: 'slack_proof_auto_post',
    description:
      'Auto-post trusted built-in visual proof back into the originating Slack thread for Slack-started tasks',
  },

  [FeatureFlag.SuggestionRouting]: {
    defaultValue: false,
    metadataKey: 'suggestion_routing',
    description:
      'Enable grouped Slack routing and route-specific planning for the Suggest Ideas automation',
  },

  [FeatureFlag.VisualProofAutoScreencast]: {
    defaultValue: false,
    metadataKey: 'visual_proof_auto_screencast',
    description:
      'Allow capture-visual-proof to auto-classify screencast-only or both when the proof claim is temporal',
  },

  [FeatureFlag.AuthorshipRules]: {
    defaultValue: () => process.env.NODE_ENV === 'development',
    metadataKey: 'authorship_rules',
    description:
      'Gate the deployment-level authorship rules engine: the effective author / PR owner resolution stamped at enqueue time and the settings surface for authoring natural-language rules. When off, enqueue leaves the effective-authorship columns null so tasks keep default attribution behavior.',
  },

  [FeatureFlag.BackgroundSubagents]: {
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
      'Enable background subagents so the Task tool can launch subagents asynchronously via its background flag, and standard-task delivery ships the PR before visual proof instead of blocking on it. Off by default: proof runs foreground, before delivery.',
  },

  [FeatureFlag.PrReviewNotifications]: {
    defaultValue: false,
    metadataKey: 'pr_review_notifications',
    description:
      'Notify the originating conversation thread (Slack, Teams, or Telegram) of the task that owns a pull request when non-mention review feedback arrives, once the task is idle, asking whether the user wants follow-up action (notification-only: no agent turn is started)',
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
