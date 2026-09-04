import { DEPLOYMENT_METADATA_BOOLEAN_CONFIG } from './config';
import { normalizeMetadataRecord } from './deployment-previews';
import type { MetadataBooleanDescriptor } from './types';

export type {
  MetadataBooleanDescriptor,
  MetadataBooleanKind,
  MetadataRecord,
} from './types';
export { DEPLOYMENT_METADATA_BOOLEAN_CONFIG } from './config';
export { normalizeMetadataRecord } from './deployment-previews';

export function coerceToBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}

export function getBooleanMetadataDescriptorByKey(
  metadataKey: string,
): MetadataBooleanDescriptor {
  return (
    DEPLOYMENT_METADATA_BOOLEAN_CONFIG[metadataKey] ?? {
      kind: 'legacy',
      description: null,
      group: null,
    }
  );
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
