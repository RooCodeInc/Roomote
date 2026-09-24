import {
  DEPLOYMENT_EXPERIMENT_AUDIENCE,
  DEPLOYMENT_EXPERIMENT_IDS,
  DEPLOYMENT_EXPERIMENT_METADATA_KEYS,
  DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
  type DeploymentExperimentAudience,
  type DeploymentExperimentValues,
} from './config';
import { normalizeMetadataRecord } from './deployment-previews';
import type { MetadataBooleanDescriptor } from './types';

export type {
  MetadataBooleanDescriptor,
  MetadataBooleanKind,
  MetadataRecord,
} from './types';
export {
  DEPLOYMENT_EXPERIMENT_AUDIENCE,
  DEPLOYMENT_EXPERIMENT_AUDIENCES,
  DEPLOYMENT_EXPERIMENT_IDS,
  DEPLOYMENT_EXPERIMENT_METADATA_KEYS,
  DEPLOYMENT_METADATA_BOOLEAN_CONFIG,
  type DeploymentExperimentAudience,
  type DeploymentExperimentId,
  type DeploymentExperimentValues,
} from './config';
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

export function getDeploymentExperimentValues(
  metadata: unknown,
): DeploymentExperimentValues {
  const normalizedMetadata = normalizeMetadataRecord(metadata);

  return Object.fromEntries(
    DEPLOYMENT_EXPERIMENT_IDS.map((id) => [
      id,
      normalizedMetadata[DEPLOYMENT_EXPERIMENT_METADATA_KEYS[id]] === true,
    ]),
  ) as DeploymentExperimentValues;
}

export function getDeploymentExperimentAudience(
  id: string,
): DeploymentExperimentAudience | undefined {
  if (!Object.hasOwn(DEPLOYMENT_EXPERIMENT_AUDIENCE, id)) return undefined;

  return DEPLOYMENT_EXPERIMENT_AUDIENCE[
    id as keyof typeof DEPLOYMENT_EXPERIMENT_AUDIENCE
  ];
}

export function getDeploymentExperimentIdsForAudience(
  audience: DeploymentExperimentAudience,
) {
  return DEPLOYMENT_EXPERIMENT_IDS.filter(
    (id) => getDeploymentExperimentAudience(id) === audience,
  );
}

export function selectDeploymentExperimentValuesForAudiences(
  values: DeploymentExperimentValues,
  audiences: readonly DeploymentExperimentAudience[],
): Partial<DeploymentExperimentValues> {
  const allowedAudiences = new Set(audiences);
  const selected: Partial<DeploymentExperimentValues> = {};

  for (const id of DEPLOYMENT_EXPERIMENT_IDS) {
    const audience = getDeploymentExperimentAudience(id);
    if (audience && allowedAudiences.has(audience)) {
      selected[id] = values[id];
    }
  }

  return selected;
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
