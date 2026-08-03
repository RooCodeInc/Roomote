import type { MetadataRecord } from './types';

export function normalizeMetadataRecord(metadata: unknown): MetadataRecord {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as MetadataRecord)
    : {};
}
