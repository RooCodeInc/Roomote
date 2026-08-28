import { z } from 'zod';
import type { TaskArtifactType } from '@roomote/types';
import {
  TASK_INITIATOR_KINDS,
  TASK_GOAL_STATUSES,
  TASK_STATES,
  TASK_SURFACES,
  TASK_WORKFLOWS,
} from '@roomote/types';

import type {
  AcpEventType,
  AcpMessageKind,
  TaskMessageContentBlock,
  TaskMessageProtocol,
  TaskMessageRole,
} from '@roomote/types';
import type { User, TaskRun } from '@roomote/db';

/** How a task's creator should be displayed, derived from initiator columns. */
export type TaskCreatorKind = 'user' | 'automation' | 'external';

export const taskSchema = z.object({
  id: z.string(),
  harnessSessionId: z.string().nullable().optional(),
  initiatorKind: z.enum(TASK_INITIATOR_KINDS),
  initiatorUserId: z.string().nullable(),
  initiatorAutomation: z.string().nullable(),
  actorExternalId: z.string().nullable().optional(),
  actorDisplayName: z.string().nullable().optional(),
  attributionLabel: z.string().optional(),
  attributionKind: z.string().nullable().optional(),
  title: z.string(),
  model: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  modelDisplayName: z.string().nullable().optional(),
  mode: z.string().nullable(),
  state: z.enum(TASK_STATES),
  goalStatus: z.enum(TASK_GOAL_STATUSES).nullable().optional(),
  goalBlockedReason: z.string().nullable().optional(),
  workflow: z.enum(TASK_WORKFLOWS).optional(),
  surface: z.enum(TASK_SURFACES).optional(),
  timestamp: z.coerce.number(),
  activityAt: z.coerce.number().optional(),
  createdAt: z.coerce.date().optional(),
  repositoryUrl: z.string().nullable().optional(),
  repositoryName: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  // Conversation cargo (present when the full tasks row is returned, e.g. by
  // the by-id command; absent from trimmed list rows).
  prompt: z.string().nullable().optional(),
  draftPrompt: z.string().nullable().optional(),
  slackChannelId: z.string().nullable().optional(),
  slackThreadTs: z.string().nullable().optional(),
  linearSessionId: z.string().nullable().optional(),
  linearIssueId: z.string().nullable().optional(),
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

/**
 * Task run row decorated with the task's latest pull-request association
 * (task_pull_requests is the only PR home; runs carry no PR columns).
 */
export type TaskRunWithPullRequest = TaskRun & {
  prRepo: string | null;
  prNumber: number | null;
  pullRequests?: Array<{
    repository: string;
    prNumber: number;
    prUrl?: string;
  }>;
};

export type TaskWithAssociations = Task & {
  attributionKind?: TaskCreatorKind | null;
  user: User | null;
  taskRun: TaskRunWithPullRequest | null;
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
