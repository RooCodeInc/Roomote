import type { MetadataRecord } from './types';

export function normalizeMetadataRecord(metadata: unknown): MetadataRecord {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as MetadataRecord)
    : {};
}

export function getDeploymentPreviewsEnabledSetting(
  metadata: unknown,
): boolean | undefined {
  const value = normalizeMetadataRecord(metadata).previews_enabled;
  return typeof value === 'boolean' ? value : undefined;
}

export function areDeploymentPreviewsEnabled(metadata: unknown): boolean {
  return getDeploymentPreviewsEnabledSetting(metadata) === true;
}

export function setDeploymentPreviewsEnabled(
  metadata: unknown,
  enabled: boolean,
): MetadataRecord {
  return {
    ...normalizeMetadataRecord(metadata),
    previews_enabled: enabled,
  };
}
