import { z } from 'zod';

import { environmentConfigSchema } from './environment-config';

export const taskWorkspaceTransitionStatuses = [
  'requested',
  'quiescing_source',
  'blocked',
  'stopping_source',
  'creating_target',
  'target_queued',
  'succeeded',
  'failed',
  'canceled',
] as const;

export const taskWorkspaceTransitionStatusSchema = z.enum(
  taskWorkspaceTransitionStatuses,
);
export type TaskWorkspaceTransitionStatus = z.infer<
  typeof taskWorkspaceTransitionStatusSchema
>;

export const workspaceGitRepositoryStateSchema = z.object({
  repository: z.string().min(1),
  branch: z.string().min(1).nullable(),
  headSha: z.string().min(1).nullable(),
  upstream: z.string().min(1).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  dirtyPaths: z.array(z.string()),
});
export type WorkspaceGitRepositoryState = z.infer<
  typeof workspaceGitRepositoryStateSchema
>;

export const workspaceGitManifestSchema = z.object({
  repositories: z.array(workspaceGitRepositoryStateSchema),
  inspectedAt: z.string().datetime(),
});
export type WorkspaceGitManifest = z.infer<typeof workspaceGitManifestSchema>;

/** Immutable target workspace material captured when a switch is requested. */
export const resolvedWorkspaceSpecSchema = z.object({
  version: z.literal(1),
  environmentId: z.string().uuid(),
  environmentConfigVersionId: z.string().uuid(),
  environmentName: z.string().min(1),
  config: environmentConfigSchema,
});
export type ResolvedWorkspaceSpec = z.infer<typeof resolvedWorkspaceSpecSchema>;

export const taskWorkspaceHandoffSchema = z.object({
  summary: z.string().min(1).max(12_000),
  sourceRunId: z.number().int().positive(),
  sourceEnvironmentName: z.string().min(1).nullable(),
  targetEnvironmentName: z.string().min(1),
  git: workspaceGitManifestSchema.nullable(),
});
export type TaskWorkspaceHandoff = z.infer<typeof taskWorkspaceHandoffSchema>;

export const requestTaskWorkspaceTransitionSchema = z.object({
  taskId: z.string().min(1),
  targetEnvironmentId: z.string().uuid(),
});
export type RequestTaskWorkspaceTransition = z.infer<
  typeof requestTaskWorkspaceTransitionSchema
>;

export const taskWorkspaceTransitionInputPayloadSchema = z.object({
  prompt: z.string().min(1),
  actingUserId: z.string().min(1).nullable(),
});
export type TaskWorkspaceTransitionInputPayload = z.infer<
  typeof taskWorkspaceTransitionInputPayloadSchema
>;
