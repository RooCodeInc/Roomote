import {
  DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
  FEATURE_FLAG_CONFIG,
} from './config';
import { normalizeMetadataRecord } from './deployment-previews';
import {
  FeatureFlag,
  type FeatureFlagConfig,
  type FeatureFlagValue,
  type FeatureFlagValues,
  type MetadataBooleanDescriptor,
  type MetadataBooleanKind,
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
export { normalizeMetadataRecord } from './deployment-previews';

export function coerceToBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}

function getFeatureFlagConfig(flag: FeatureFlag): FeatureFlagConfig {
  const config = (
    FEATURE_FLAG_CONFIG as Partial<Record<string, FeatureFlagConfig>>
  )[flag];

  if (!config) {
    throw new Error(`Unknown feature flag: ${String(flag)}`);
  }

  return config;
}

export function getFeatureFlagMetadataKey(flag: FeatureFlag): string {
  const config = getFeatureFlagConfig(flag);
  const flagName = String(flag);
  return (
    config.metadataKey || flagName.charAt(0).toLowerCase() + flagName.slice(1)
  );
}

export function getFeatureFlagMetadataKeys(flag: FeatureFlag): string[] {
  const primaryMetadataKey = getFeatureFlagMetadataKey(flag);
  const config = getFeatureFlagConfig(flag);

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
  for (const config of Object.values(
    FEATURE_FLAG_CONFIG,
  ) as FeatureFlagConfig[]) {
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
  const config = getFeatureFlagConfig(flag);

  if (config.override !== undefined) {
    const overrideValue =
      typeof config.override === 'function'
        ? config.override()
        : config.override;
    return coerceToBoolean(overrideValue);
  }

  for (const metadataSource of metadataSources) {
    const metadata = normalizeMetadataRecord(metadataSource);

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
  const normalizedMetadata = normalizeMetadataRecord(metadata);

  return Object.fromEntries(
    (Object.values(FeatureFlag) as FeatureFlag[]).map((flag) => [
      flag,
      evaluateFeatureFlagFromMetadata(flag, normalizedMetadata),
    ]),
  ) as FeatureFlagValues;
}

export const ANONYMOUS_ANALYTICS_METADATA_KEY =
  'anonymous_analytics_enabled' as const;

export function isAnonymousAnalyticsEnabledFromMetadata(
  metadata: unknown,
  cloudEnabled = false,
): boolean {
  if (cloudEnabled) return true;

  const normalizedMetadata = normalizeMetadataRecord(metadata);
  if (!(ANONYMOUS_ANALYTICS_METADATA_KEY in normalizedMetadata)) return true;

  return coerceToBoolean(normalizedMetadata[ANONYMOUS_ANALYTICS_METADATA_KEY]);
}
