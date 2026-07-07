/**
 * Feature flags package - Client-side exports.
 *
 * This module exports types and configurations that can be used
 * on both client and server side.
 */

import {
  DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
  FEATURE_FLAG_CONFIG,
} from './config';
import { normalizeMetadataRecord } from './deployment-previews';
import {
  FeatureFlag,
  type MetadataBooleanDescriptor,
  type MetadataBooleanKind,
  type FeatureFlagValue,
  type FeatureFlagValues,
} from './types';

export { FeatureFlag } from './types';

export type {
  FeatureFlagConfig,
  FeatureFlagConfigMap,
  FeatureFlagValue,
  FeatureFlagValues,
  FeatureFlagContext,
  MetadataBooleanDescriptor,
  MetadataBooleanKind,
  MetadataRecord,
} from './types';

export {
  DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
  FEATURE_FLAG_CONFIG,
} from './config';
export {
  areDeploymentPreviewsEnabled,
  getDeploymentPreviewsEnabledSetting,
  normalizeMetadataRecord,
  setDeploymentPreviewsEnabled,
} from './deployment-previews';

/**
 * Coerce a value to boolean for boolean flags.
 * This ensures consistent behavior between client and server.
 */
export function coerceToBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return Boolean(value);
}

export function getFeatureFlagMetadataKey(flag: FeatureFlag): string {
  const config = FEATURE_FLAG_CONFIG[flag];
  return config.metadataKey || flag.charAt(0).toLowerCase() + flag.slice(1);
}

export function getFeatureFlagMetadataKeys(flag: FeatureFlag): string[] {
  const primaryMetadataKey = getFeatureFlagMetadataKey(flag);
  const config = FEATURE_FLAG_CONFIG[flag];

  return [
    primaryMetadataKey,
    ...(config.legacyMetadataKeys ?? []).filter(
      (metadataKey) => metadataKey !== primaryMetadataKey,
    ),
  ];
}

export function getBooleanMetadataDescriptorByKey(
  metadataKey: string,
): MetadataBooleanDescriptor {
  for (const config of Object.values(FEATURE_FLAG_CONFIG) as Array<{
    metadataKey?: string;
    legacyMetadataKeys?: string[];
    description?: string;
    group?: string;
  }>) {
    if (
      config.metadataKey === metadataKey ||
      config.legacyMetadataKeys?.includes(metadataKey)
    ) {
      return {
        kind: 'feature-flag' satisfies MetadataBooleanKind,
        description: config.description ?? null,
        group: config.group ?? null,
      };
    }
  }

  return (
    DEPLOYMENT_METADATA_BOOLEAN_CONFIG[metadataKey] ?? {
      kind: 'legacy',
      description: null,
      group: null,
    }
  );
}

export function getFeatureFlagDescriptionByMetadataKey(metadataKey: string) {
  return getBooleanMetadataDescriptorByKey(metadataKey).description;
}

export function evaluateFeatureFlagFromMetadata(
  flag: FeatureFlag,
  metadata: unknown,
): boolean {
  return evaluateFeatureFlagFromMetadataSources(flag, [metadata]);
}

export function evaluateFeatureFlagFromMetadataSources(
  flag: FeatureFlag,
  metadataSources: unknown[],
): boolean {
  const config = FEATURE_FLAG_CONFIG[flag];

  if (config.override !== undefined) {
    const overrideValue =
      typeof config.override === 'function'
        ? config.override()
        : config.override;
    return coerceToBoolean(overrideValue);
  }

  for (const metadataSource of metadataSources) {
    const metadata = normalizeMetadataRecord(metadataSource);

    if (Object.keys(metadata).length === 0) {
      continue;
    }

    for (const metadataKey of getFeatureFlagMetadataKeys(flag)) {
      if (metadataKey in metadata) {
        return coerceToBoolean(metadata[metadataKey] as FeatureFlagValue);
      }
    }
  }

  const defaultValue =
    typeof config.defaultValue === 'function'
      ? config.defaultValue()
      : config.defaultValue;
  return coerceToBoolean(defaultValue);
}

export function evaluateFeatureFlagsFromMetadata(
  metadata: unknown,
): FeatureFlagValues {
  const result = {} as FeatureFlagValues;
  const normalizedMetadata = normalizeMetadataRecord(metadata);

  for (const flag of Object.values(FeatureFlag)) {
    result[flag] = evaluateFeatureFlagFromMetadata(flag, normalizedMetadata);
  }

  return result;
}

export function isShowDebugUIEnabledFromMetadata(metadata: unknown): boolean {
  const normalizedMetadata = normalizeMetadataRecord(metadata);

  return (
    evaluateFeatureFlagFromMetadata(
      FeatureFlag.ShowDebugUISetting,
      normalizedMetadata,
    ) && coerceToBoolean(normalizedMetadata?.show_debug_ui)
  );
}

export const ANONYMOUS_ANALYTICS_METADATA_KEY =
  'anonymous_analytics_enabled' as const;

/**
 * Anonymous analytics is opt-out: an absent metadata key means enabled.
 * Only an explicit false-y value stored by an admin disables it.
 */
export function isAnonymousAnalyticsEnabledFromMetadata(
  metadata: unknown,
): boolean {
  const normalizedMetadata = normalizeMetadataRecord(metadata);

  if (!(ANONYMOUS_ANALYTICS_METADATA_KEY in normalizedMetadata)) {
    return true;
  }

  return coerceToBoolean(normalizedMetadata[ANONYMOUS_ANALYTICS_METADATA_KEY]);
}
