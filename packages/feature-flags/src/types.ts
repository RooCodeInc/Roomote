/**
 * Feature flag types and configuration
 */

export const FeatureFlag = {
  ComposerSuggestions: 'composerSuggestions',
} as const;

export type FeatureFlag = (typeof FeatureFlag)[keyof typeof FeatureFlag];

export type FeatureFlagValue =
  | boolean
  | string
  | number
  | Record<string, unknown>;

export interface FeatureFlagConfig<T extends FeatureFlagValue = boolean> {
  defaultValue: T | (() => T);
  override?: T | (() => T);
  metadataKey?: string;
  legacyMetadataKeys?: string[];
  description?: string;
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
  [K in FeatureFlag]?: boolean;
};

export type FeatureFlagContext =
  | { isDeploymentContext: true }
  | { isDeploymentContext: false; userId: string };

export interface MetadataRecord {
  queue_parallel_task_limit?: boolean | number | string;
  deployment_disabled?: boolean;
  anonymous_analytics_enabled?: boolean;
  [key: string]: unknown;
}
