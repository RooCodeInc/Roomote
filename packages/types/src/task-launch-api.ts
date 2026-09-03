import { z } from 'zod';

import { launchCodingHarnesses, REASONING_EFFORT_VALUES } from './task-runs';
import { computeProviders } from './compute-providers';
import { ALL_REPOSITORIES } from './constants';
import { gitBranchNameSchema } from './git-ref';
import {
  appendEnvironmentDefinitionGuidance,
  buildCreateEnvironmentDefinitionPrompt,
  buildEnvironmentDefinitionWorkspacePayload,
} from './environment-definition-tasks';

export const launchTaskTypeSchema = z.enum([
  'standard',
  'environment-definition',
  'suggested-tasks',
]);

export type TaskLaunchType = z.infer<typeof launchTaskTypeSchema>;

export type TaskLaunchWorkspacePayload = {
  repo: string;
  selectedRepositories?: string[];
};

export type TaskTypePromptAndWorkspacePayloadResult = {
  taskPrompt: string;
  workspacePayload: TaskLaunchWorkspacePayload;
  visibleInTranscript?: boolean;
};

export const ENVIRONMENT_DEFINITION_REPOSITORY_SELECTION_REQUIRED_ERROR =
  'environment-definition tasks require at least one selected repository';

export class TaskTypePromptAndWorkspacePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTypePromptAndWorkspacePayloadError';
  }
}

export function buildTaskTypePromptAndWorkspacePayload({
  type = 'standard',
  prompt,
  repo,
  repositoryFullNames,
  setupGuidance,
}: {
  type?: string | null | undefined;
  prompt?: string | null | undefined;
  repo?: string | null | undefined;
  repositoryFullNames?: string[] | null | undefined;
  setupGuidance?: string | null | undefined;
}): TaskTypePromptAndWorkspacePayloadResult {
  const visibleInTranscript = type === 'standard' ? undefined : false;

  if (
    type === 'environment-definition' &&
    (!repositoryFullNames || repositoryFullNames.length === 0) &&
    (!repo || repo === ALL_REPOSITORIES)
  ) {
    throw new TaskTypePromptAndWorkspacePayloadError(
      ENVIRONMENT_DEFINITION_REPOSITORY_SELECTION_REQUIRED_ERROR,
    );
  }

  const workspacePayload =
    repositoryFullNames && repositoryFullNames.length > 0
      ? buildEnvironmentDefinitionWorkspacePayload(repositoryFullNames)
      : { repo: repo ?? '' };

  if (type === 'environment-definition') {
    return {
      taskPrompt: appendEnvironmentDefinitionGuidance(
        buildCreateEnvironmentDefinitionPrompt(repositoryFullNames ?? []),
        [setupGuidance?.trim(), prompt?.trim()]
          .filter((value): value is string => Boolean(value))
          .join('\n\n'),
      ),
      workspacePayload,
      visibleInTranscript,
    };
  }

  return {
    taskPrompt: prompt ?? '',
    workspacePayload,
    visibleInTranscript,
  };
}

export const ADMIN_REQUIRED_LAUNCH_TYPES = new Set<TaskLaunchType>([
  'environment-definition',
  'suggested-tasks',
]);

export const standardTaskBootstrapSchema = z
  .object({
    skill: z.enum(['explain-repo-code', 'plan-repo-implementation']).optional(),
    interactiveMode: z.boolean().optional(),
  })
  .optional();

export const taskLaunchRequestSchema = z.object({
  prompt: z.string().trim().optional(),
  repo: z.string().trim().optional(),
  branch: gitBranchNameSchema.optional(),
  sha: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i, 'sha must be a git commit SHA')
    .optional(),
  environmentId: z.string().uuid().optional(),
  /**
   * Idempotency key for standard launches. Retrying with the same id returns
   * the task the first request created instead of starting another one.
   */
  launchId: z.string().uuid().optional(),
  type: launchTaskTypeSchema.optional(),
  repositoryFullNames: z.array(z.string().trim().min(1)).min(1).optional(),
  selectedRepositories: z.array(z.string().trim().min(1)).min(1).optional(),
  setupGuidance: z.string().optional(),
  visibleInTranscript: z.boolean().optional(),
  hidden: z.boolean().optional(),
  computeProvider: z.enum(computeProviders).optional(),
  harness: z.enum(launchCodingHarnesses).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
  bootstrap: standardTaskBootstrapSchema,
  trigger: z.enum(['onboarding', 'scheduled']).optional(),
  notifySlack: z.boolean().optional(),
  /**
   * When true and the launch is authenticated as a task run, the platform
   * delivers a message into that launching run's session when the spawned
   * task's run settles (completes, fails, is canceled, or goes idle). Lets a
   * parent task consume a spawned task's outcome deterministically instead of
   * polling. Standard launches only.
   */
  notifyOnSettle: z.boolean().optional(),
});

export type TaskLaunchRequest = z.infer<typeof taskLaunchRequestSchema>;
