/**
 * Feature flag types and configuration
 */

export enum FeatureFlag {
  SlackEvalLauncher = 'SlackEvalLauncher',
  ShowDebugUISetting = 'ShowDebugUISetting',
  SlackProofAutoPost = 'SlackProofAutoPost',
  SuggestionRouting = 'SuggestionRouting',
  VisualProofAutoScreencast = 'VisualProofAutoScreencast',
  AuthorshipRules = 'AuthorshipRules',
  BackgroundSubagents = 'BackgroundSubagents',
}

export type FeatureFlagValue =
  | boolean
  | string
  | number
  | Record<string, unknown>;

export interface FeatureFlagConfig<T extends FeatureFlagValue = boolean> {
  /**
   * The default value to use if the flag is not set in metadata
   */
  defaultValue: T | (() => T);

  /**
   * Optional override value that takes precedence over metadata
   * Useful for gradual rollouts and feature cleanup
   */
  override?: T | (() => T);

  /**
   * The key in the metadata jsonb column to look for this flag
   */
  metadataKey?: string;

  /**
   * Older metadata keys that should still enable this flag during a
   * rollout rename. The primary metadataKey takes precedence when both exist.
   */
  legacyMetadataKeys?: string[];

  /**
   * Optional description for documentation
   */
  description?: string;

  /**
   * Optional admin UI grouping label for segregating related metadata controls.
   */
  group?: string;
}

export type MetadataBooleanKind =
  | 'feature-flag'
  | 'deployment-control'
  | 'legacy';

export interface MetadataBooleanDescriptor {
  description: string | null;
  kind: MetadataBooleanKind;
  group: string | null;
}

export type FeatureFlagConfigMap = {
  [K in FeatureFlag]: FeatureFlagConfig;
};

export type FeatureFlagValues = {
  [K in FeatureFlag]: boolean;
};

/**
 * Evaluation context for feature flags.
 * - isDeploymentContext: true => deployment-wide metadata.
 * - isDeploymentContext: false => userId is required.
 */
export type FeatureFlagContext =
  | {
      isDeploymentContext: true;
    }
  | {
      isDeploymentContext: false;
      userId: string;
    };

export interface MetadataRecord {
  slack_eval_launcher?: boolean;
  show_debug_ui_setting?: boolean;
  show_debug_ui?: boolean;
  slack_proof_auto_post?: boolean;
  queue_parallel_task_limit?: boolean | number | string;
  suggestion_routing?: boolean;
  visual_proof_auto_screencast?: boolean;
  authorship_rules?: boolean;
  background_subagents?: boolean;
  previews_enabled?: boolean;
  deployment_disabled?: boolean;
  anonymous_analytics_enabled?: boolean;
  [key: string]: unknown;
}
