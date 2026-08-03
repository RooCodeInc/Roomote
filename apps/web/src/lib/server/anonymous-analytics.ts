export const ANONYMOUS_ANALYTICS_METADATA_KEY =
  'anonymous_analytics_enabled' as const;

export function normalizeMetadataRecord(
  metadata: unknown,
): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function coerceToBoolean(value: unknown): boolean {
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

export function isAnonymousAnalyticsEnabledFromMetadata(
  metadata: unknown,
  cloudEnabled = false,
): boolean {
  if (cloudEnabled) {
    return true;
  }

  const normalizedMetadata = normalizeMetadataRecord(metadata);

  if (!(ANONYMOUS_ANALYTICS_METADATA_KEY in normalizedMetadata)) {
    return true;
  }

  return coerceToBoolean(normalizedMetadata[ANONYMOUS_ANALYTICS_METADATA_KEY]);
}
