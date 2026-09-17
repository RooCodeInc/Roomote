export type MetadataBooleanKind = 'deployment-control' | 'legacy';

export interface MetadataBooleanDescriptor {
  description: string | null;
  kind: MetadataBooleanKind;
  group: string | null;
}

export interface MetadataRecord {
  queue_parallel_task_limit?: boolean | number | string;
  deployment_disabled?: boolean;
  anonymous_analytics_enabled?: boolean;
  [key: string]: unknown;
}
