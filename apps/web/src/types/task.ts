import { z } from 'zod';
import type { TaskArtifactType, TaskAttributionKind } from '@roomote/types';

import type {
  AcpEventType,
  AcpMessageKind,
  TaskMessageContentBlock,
  TaskMessageProtocol,
  TaskMessageRole,
} from '@roomote/types';
import type { User, CloudJob } from '@roomote/db';

export const taskSchema = z.object({
  id: z.string(),
  harnessSessionId: z.string().nullable().optional(),
  userId: z.string().nullable(),
  attributionLabel: z.string().optional(),
  attributionKind: z.string().nullable().optional(),
  title: z.string(),
  model: z.string().nullable().optional(),
  modelDisplayName: z.string().nullable().optional(),
  mode: z.string().nullable(),
  completed: z.coerce.boolean(),
  timestamp: z.coerce.number(),
  activityAt: z.coerce.number().optional(),
  createdAt: z.coerce.date().optional(),
  repositoryUrl: z.string().nullable().optional(),
  repositoryName: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
});

export type Task = z.infer<typeof taskSchema>;

export type TaskArtifact = {
  id: string;
  path: string;
  version: number;
  artifactType: TaskArtifactType;
  contentType: string;
  size: number;
  createdAt: Date;
  thumbnailUrl?: string;
  previewUrl?: string;
};

export type ArtifactWithContent = {
  id: string;
  taskId: string;
  path: string;
  version: number;
  artifactType: TaskArtifactType;
  contentType: string;
  size: number;
  createdAt: Date;
  downloadUrl: string;
  content?: string;
  rawUrl?: string;
};

export type TaskWithAssociations = Task & {
  attributionKind?: TaskAttributionKind | null;
  user: User | null;
  cloudJob: CloudJob | null;
  artifacts?: TaskArtifact[];
  inferenceUsage?: TaskInferenceUsageSummary;
};

export type TaskInferenceUsageSummary = {
  eventCount: number;
  costMicroUsd: number;
};

export interface TaskMessageEnvelope {
  id: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  userImageUrl: string | null;
  taskId: string;
  ts: number;
  createdAt: number;
  sequence: number | null;
  eventType: AcpEventType;
  role: TaskMessageRole;
  kind: AcpMessageKind;
  protocol: TaskMessageProtocol;
  contentBlocks: TaskMessageContentBlock[];
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  visibleInTranscript?: boolean;
  text?: string;
}
