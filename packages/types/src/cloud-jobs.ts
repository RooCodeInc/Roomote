import { z } from 'zod';

import {
  type ComputeProvider,
  computeProviders,
} from './compute-providers/compute-provider';
import {
  communicationProviderSchema,
  isCommunicationProvider,
  type CommunicationProvider,
  queuedCommunicationMessageSchema,
} from './communication';
import { SANDBOX_SNAPSHOT_EXPIRY_MS } from './compute-providers/worker-runtime';
import { prActions } from './cloud-agents';
import { ALL_REPOSITORIES } from './constants';
import { sourceControlProviderSchema } from './source-control';

/**
 * CloudTaskType
 *
 * This is currently a hybrid of task types and trigger types. For example,
 * We should cleanly separate these concepts, and represent a cloud job as an
 * <agent, trigger> tuple. The agent determines which workflow will be executed
 * and what settings are used to execute the workflow, while the trigger determines
 * how progress and the final result are communicated.
 */

export enum CloudTaskType {
  StandardTask = 'standard.task',
  SuggestedTasks = 'suggested.tasks',
  McpRecommendations = 'mcp.recommendations',
  /**
   * Historical task type kept so old cloud job rows still parse and render.
   * New launches should use `SuggestedTasks`.
   */
  LegacyOnboardingSuggestions = 'onboarding.task.suggestions',

  GithubIssueFix = 'github.issue.fix',
  GithubIssueCommentRespond = 'github.issue.comment.respond',

  GithubPrReview = 'github.pr.review',
  GithubPrReviewSync = 'github.pr.review.sync',
  GithubPrReviewFollowUp = 'github.pr.review.followup',
  GithubPrConflictResolve = 'github.pr.conflict.resolve',

  SlackAppMention = 'slack.app.mention',

  LinearAgentSession = 'linear.agent.session',

  SnapshotEnvironment = 'snapshot.environment',
  SnapshotResume = 'snapshot.resume',
}

export const TASK_ATTRIBUTION_KINDS = [
  'matched_user',
  'unlinked_user',
  'automatic',
] as const;

export type TaskAttributionKind = (typeof TASK_ATTRIBUTION_KINDS)[number];

export const TASK_ATTRIBUTION_SOURCE_KINDS = [
  'slack',
  'teams',
  'telegram',
  'github',
  'gitlab',
  'gitea',
  'ado',
  'linear',
  'web',
  'system',
  'automation',
] as const;

export type TaskAttributionSourceKind =
  (typeof TASK_ATTRIBUTION_SOURCE_KINDS)[number];

export const EFFECTIVE_AUTHOR_KINDS = ['roomote', 'human'] as const;

export type EffectiveAuthorKind = (typeof EFFECTIVE_AUTHOR_KINDS)[number];

export const EFFECTIVE_PR_OWNER_KINDS = [
  'inherit_author',
  'specific_user',
  'none',
] as const;

export type EffectivePrOwnerKind = (typeof EFFECTIVE_PR_OWNER_KINDS)[number];

export type EffectiveAuthorReason =
  | 'default_roomote'
  | 'human_created'
  | 'rule_roomote'
  | 'rule_matched_human'
  | 'rule_specific_user';

export type EffectivePrOwnerReason =
  | 'inherit_author'
  | 'rule_none'
  | 'rule_matched_human'
  | 'rule_specific_user';

export type AuthorshipRuleActor = {
  userId: string | null;
  displayName: string | null;
  githubLogin: string | null;
  githubUserId: number | null;
};

export type AuthorshipRuleConditions = {
  sourceKinds: TaskAttributionSourceKind[];
  taskTypes: CloudTaskType[];
  repositoryFullNames: string[];
  humanCreated: boolean | null;
};

export type AuthorshipRuleAuthorDecision =
  | {
      mode: 'unchanged';
      actor: null;
    }
  | {
      mode: 'roomote';
      actor: null;
    }
  | {
      mode: 'matched_human';
      actor: null;
    }
  | {
      mode: 'specific_user';
      actor: AuthorshipRuleActor;
    };

export type AuthorshipRulePrOwnerDecision =
  | {
      mode: 'unchanged';
      actor: null;
    }
  | {
      mode: 'inherit_author';
      actor: null;
    }
  | {
      mode: 'none';
      actor: null;
    }
  | {
      mode: 'matched_human';
      actor: null;
    }
  | {
      mode: 'specific_user';
      actor: AuthorshipRuleActor;
    };

export type CompiledAuthorshipRule = {
  id: string;
  priority: number;
  label: string;
  conditions: AuthorshipRuleConditions;
  author: AuthorshipRuleAuthorDecision;
  prOwner: AuthorshipRulePrOwnerDecision;
  rationale: string;
};

export type AuthorshipRuleIssue = {
  severity: 'error' | 'warning';
  message: string;
};

export type SuggestionCategory =
  | 'bug'
  | 'security'
  | 'chore'
  | 'feature'
  | 'improvement';

export type SuggestionPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TaskSuggestionStatus = 'open' | 'started' | 'dismissed';
export const TASK_SUGGESTION_SOURCES = [
  'suggest_ideas',
  'sentry_triage',
  'dependabot_triage',
  'security_auditor',
  'code_quality_auditor',
  'ci_failure_triage',
] as const;
export type TaskSuggestionSource = (typeof TASK_SUGGESTION_SOURCES)[number];
export const AUTOMATION_WORK_ITEM_DISPOSITIONS = ['suggest', 'act'] as const;
export type AutomationWorkItemDisposition =
  (typeof AUTOMATION_WORK_ITEM_DISPOSITIONS)[number];
export const AUTOMATION_WORK_ITEM_STATUSES = [
  'open',
  'acting',
  'started',
  'failed',
  'dismissed',
] as const;
export type AutomationWorkItemStatus =
  (typeof AUTOMATION_WORK_ITEM_STATUSES)[number];
export const ACTIVE_AUTOMATION_WORK_ITEM_STATUSES: readonly AutomationWorkItemStatus[] =
  ['open', 'acting', 'started'] as const;

/**
 * Launch classes used to choose runtime policy for cloud tasks.
 */

export const CLOUD_TASK_LAUNCH_CLASSES = [
  'human',
  'automation',
  'maintenance',
] as const;

export type CloudTaskLaunchClass = (typeof CLOUD_TASK_LAUNCH_CLASSES)[number];

export const REASONING_EFFORT_VALUES = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORT_VALUES.includes(value as ReasoningEffort);
}

const openCodeModelOverrideSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^/\s]+\/.+$/u, 'OpenCode model must use provider/model format.');

export const SUGGESTION_CATEGORIES: readonly SuggestionCategory[] = [
  'bug',
  'security',
  'chore',
  'feature',
  'improvement',
] as const;

export const SUGGESTION_PRIORITIES: readonly SuggestionPriority[] = [
  'P0',
  'P1',
  'P2',
  'P3',
] as const;

export const TASK_SUGGESTION_STATUSES: readonly TaskSuggestionStatus[] = [
  'open',
  'started',
  'dismissed',
] as const;

export const ACTIVE_TASK_SUGGESTION_STATUSES: readonly TaskSuggestionStatus[] =
  ['open', 'started'] as const;

export const SUGGESTION_CATEGORY_EMOJIS: Record<SuggestionCategory, string> = {
  bug: '🐛',
  security: '🔒',
  chore: '🧹',
  feature: '✨',
  improvement: '🔧',
};

export const SUGGESTION_CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  bug: 'Bug',
  security: 'Sec',
  chore: 'Chore',
  feature: 'Feat',
  improvement: 'Improv',
};

export const suggestionCategorySet = new Set<string>(SUGGESTION_CATEGORIES);

export const SUGGESTION_PRIORITY_EMOJIS: Record<SuggestionPriority, string> = {
  P0: '🔴',
  P1: '🟠',
  P2: '🟡',
  P3: '🟢',
};

export const SUGGESTION_PRIORITY_LABELS: Record<SuggestionPriority, string> = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
};

export const suggestionPrioritySet = new Set<string>(SUGGESTION_PRIORITIES);
export const taskSuggestionStatusSet = new Set<string>(
  TASK_SUGGESTION_STATUSES,
);

export const cloudTaskTypes = Object.values(CloudTaskType) as CloudTaskType[];

export function isCloudTaskType(value: string): value is CloudTaskType {
  return cloudTaskTypes.includes(value as CloudTaskType);
}

export const HIDDEN_CLOUD_TASK_TYPES: ReadonlySet<CloudTaskType> = new Set([
  CloudTaskType.SuggestedTasks,
  CloudTaskType.McpRecommendations,
  CloudTaskType.LegacyOnboardingSuggestions,
  CloudTaskType.SnapshotEnvironment,
]);

export function isHiddenCloudTaskType(type: CloudTaskType): boolean {
  return HIDDEN_CLOUD_TASK_TYPES.has(type);
}

export const DEFAULT_VISIBLE_CLOUD_TASK_TYPES = cloudTaskTypes.filter(
  (type) => !isHiddenCloudTaskType(type),
);

const IMPLICIT_GENERALIST_TASK_TYPES: ReadonlySet<CloudTaskType> = new Set([
  CloudTaskType.StandardTask,
  CloudTaskType.SuggestedTasks,
  CloudTaskType.McpRecommendations,
  CloudTaskType.LegacyOnboardingSuggestions,
  CloudTaskType.GithubPrReviewFollowUp,
  CloudTaskType.SlackAppMention,
  CloudTaskType.LinearAgentSession,
  CloudTaskType.SnapshotResume,
]);

export function isImplicitGeneralistTaskType(type: CloudTaskType): boolean {
  return IMPLICIT_GENERALIST_TASK_TYPES.has(type);
}

/**
 * Returns true if the given task type should have environment services started.
 * Uses a deny list approach - services are enabled for all types except those
 * that explicitly don't need them.
 */
export function isServicesEnabledCloudTaskType(_type: CloudTaskType): boolean {
  return true;
}

const RESUMABLE_CLOUD_TASK_TYPES: ReadonlySet<CloudTaskType> = new Set([
  CloudTaskType.StandardTask,
  CloudTaskType.SuggestedTasks,
  CloudTaskType.LegacyOnboardingSuggestions,
  CloudTaskType.GithubIssueFix,
  CloudTaskType.GithubIssueCommentRespond,
  CloudTaskType.GithubPrReviewFollowUp,
  CloudTaskType.SlackAppMention,
  CloudTaskType.LinearAgentSession,
  CloudTaskType.SnapshotResume,
]);

/**
 * Returns true when a task type should be auto-snapshotted at `sleepAt` and
 * therefore supports resuming from that automatic sleep transition.
 */
export function isResumableCloudTaskType(type: CloudTaskType): boolean {
  return RESUMABLE_CLOUD_TASK_TYPES.has(type);
}

export const EXPIRED_SNAPSHOT_RESUME_ERROR =
  'This task snapshot has expired and can no longer be resumed.';

export function isSnapshotResumable(
  snapshotCreatedAt: Date | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (
    !(snapshotCreatedAt instanceof Date) ||
    Number.isNaN(snapshotCreatedAt.getTime())
  ) {
    return false;
  }

  return nowMs - snapshotCreatedAt.getTime() < SANDBOX_SNAPSHOT_EXPIRY_MS;
}

const COMPLETE_TASK_ON_SNAPSHOT_PAYLOAD_FLAG = '__completeTaskOnSnapshot';

function normalizeTaskPayloadRecord(payload: unknown): Record<string, unknown> {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return {};
  }

  return payload as Record<string, unknown>;
}

export function shouldCompleteTaskOnSnapshot(payload: unknown): boolean {
  return (
    normalizeTaskPayloadRecord(payload)[
      COMPLETE_TASK_ON_SNAPSHOT_PAYLOAD_FLAG
    ] === true
  );
}

export function withCompleteTaskOnSnapshot(
  payload: unknown,
): Record<string, unknown> {
  return {
    ...normalizeTaskPayloadRecord(payload),
    [COMPLETE_TASK_ON_SNAPSHOT_PAYLOAD_FLAG]: true,
  };
}

export function withoutCompleteTaskOnSnapshot(
  payload: unknown,
): Record<string, unknown> {
  const normalizedPayload = normalizeTaskPayloadRecord(payload);
  const { [COMPLETE_TASK_ON_SNAPSHOT_PAYLOAD_FLAG]: _ignored, ...rest } =
    normalizedPayload;

  return rest;
}

/**
 * Returns true if the given task type should always use the app-scoped
 * GitHub installation token instead of a linked user token.
 *
 * This applies to task types spawned by *autonomous* agents (see
 * `isAutonomousAgent()` in cloud-agents.ts). Those agents act as
 * their own entity -- PR Reviewer review and follow-up tasks comment on behalf
 * of the app so their feedback is clearly distinguishable from human comments.
 * Without this, linking a GitHub account causes these agents to
 * masquerade as the user.
 */
export function shouldUseAppTokenOnly(type: CloudTaskType): boolean {
  const appTokenOnlyTypes: CloudTaskType[] = [
    CloudTaskType.GithubPrReview,
    CloudTaskType.GithubPrReviewSync,
    CloudTaskType.GithubPrReviewFollowUp,
    CloudTaskType.GithubPrConflictResolve,
  ];

  return appTokenOnlyTypes.includes(type);
}

/**
 * CodingHarness
 */

export const codingHarnesses = ['opencode-server'] as const;

export const launchCodingHarnesses = ['opencode-server'] as const;
export type CodingHarness = (typeof codingHarnesses)[number];
export type LaunchCodingHarness = (typeof launchCodingHarnesses)[number];
export const DEFAULT_LAUNCH_CODING_HARNESS: LaunchCodingHarness =
  'opencode-server';

export const DEFAULT_CODING_HARNESS: CodingHarness = 'opencode-server';

export type HarnessModelOverrides = {
  'opencode-server'?: string;
};

export function getHarnessModelOverride(
  overrides: HarnessModelOverrides | null | undefined,
  harness: keyof HarnessModelOverrides,
): string | undefined {
  const override = overrides?.[harness];

  return typeof override === 'string' && override.trim().length > 0
    ? override.trim()
    : undefined;
}

/** OpenCode's default primary agent used for regular task turns. */
export const OPENCODE_BUILD_AGENT = 'build';

/**
 * Roomote's generated read-mostly planning primary agent. Registered by the
 * worker's OpenCode config generation and selected per prompt while the
 * planning workflow skill is active and plan mode is enabled.
 */
export const OPENCODE_ARCHITECT_AGENT = 'architect';

export const isCodingHarness = (runtime: string): runtime is CodingHarness =>
  codingHarnesses.includes(runtime as CodingHarness);

export const isLaunchCodingHarness = (
  runtime: string,
): runtime is LaunchCodingHarness =>
  launchCodingHarnesses.includes(runtime as LaunchCodingHarness);

export function coerceLaunchCodingHarness(
  harness?: string | null,
): LaunchCodingHarness {
  const normalizedHarness = harness ?? '';

  return isLaunchCodingHarness(normalizedHarness)
    ? normalizedHarness
    : DEFAULT_LAUNCH_CODING_HARNESS;
}

export const HARNESS_LABELS: Record<CodingHarness, string> = {
  'opencode-server': 'OpenCode',
};

export function stripCloudJobErrorMarkers(
  error?: string | null,
): string | undefined {
  const sanitizedError = error?.trim();

  if (!sanitizedError) {
    return undefined;
  }

  return sanitizedError;
}

/**
 * Returns true when a string value is present and non-blank.
 * Shared utility used by harness credential resolution, proxy auth,
 * and worker env injection.
 */
export function hasNonEmptyValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * TaskToolActionId
 */

export const taskToolActionIds = [
  'simplify',
  'push',
  'create-draft-pr',
  'create-pr',
  'review-code',
  'review-and-fix',
  'address-pr-feedback',
  'capture-visual-proof',
] as const;

export type TaskToolActionId = (typeof taskToolActionIds)[number];

export const taskToolActionIdSchema = z.enum(taskToolActionIds);

export interface TaskToolDispatchPayload {
  actionId: TaskToolActionId;
}

export const taskToolDispatchPayloadSchema = z.object({
  actionId: taskToolActionIdSchema,
});

export function isTaskToolActionId(value: string): value is TaskToolActionId {
  return taskToolActionIds.some((actionId) => actionId === value);
}

type SkillCommandDelimiter = '$' | '/';

export function getSkillCommandDelimiter(
  harness?: CodingHarness,
): SkillCommandDelimiter {
  switch (harness) {
    case 'opencode-server':
    case undefined:
      return '$';
    default:
      return '$';
  }
}

export function getTaskToolInvocation(
  actionId: TaskToolActionId,
  harness?: CodingHarness,
): string {
  return `${getSkillCommandDelimiter(harness)}${actionId}`;
}

export function getTaskToolActionIdFromInvocation(
  text: string,
): TaskToolActionId | undefined {
  const trimmedText = text.trim();

  if (!trimmedText.startsWith('/') && !trimmedText.startsWith('$')) {
    return undefined;
  }

  const actionId = trimmedText.slice(1);

  return isTaskToolActionId(actionId) ? actionId : undefined;
}

/**
 * RequestedWorkKind
 *
 * Captures the initial user intent for a cloud job launch, not the full
 * lifecycle of what the task later did.
 */

export const requestedWorkKinds = [
  'question',
  'plan',
  'implement',
  'unknown',
] as const;

export type RequestedWorkKind = (typeof requestedWorkKinds)[number];

export const requestedWorkKindSources = [
  'explicit_bootstrap',
  'task_tool',
  'llm_classifier',
  'inherited',
  'system_default',
] as const;

export type RequestedWorkKindSource = (typeof requestedWorkKindSources)[number];

export const requestedWorkKindSchema = z.enum(requestedWorkKinds);

export const requestedWorkKindSourceSchema = z.enum(requestedWorkKindSources);

export const requestedWorkKindDecisionSchema = z.object({
  kind: requestedWorkKindSchema,
  source: requestedWorkKindSourceSchema,
  confidence: z.number().nullable().optional(),
});

export type RequestedWorkKindDecision = z.infer<
  typeof requestedWorkKindDecisionSchema
>;

/**
 * Remaining sandbox lifetime threshold used by the scheduled snapshot reaper.
 * Instances at or below this are considered expiring and can be snapshotted.
 */
export const SNAPSHOT_CHECK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes.

/**
 * Worker-side liveness heartbeat cadence for sandbox-backed cloud jobs.
 * This stays independent from `sleepAt`, which models keepalive/snapshot
 * deadlines rather than process health.
 */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds.

/**
 * Maximum allowed age of a worker heartbeat before BullMQ treats the worker as
 * unhealthy and attempts stale-worker recovery.
 */
export const WORKER_HEARTBEAT_STALE_MS = 2 * 60 * 1000; // 2 minutes.

/**
 * Durable audit sources for cloud job lifecycle events.
 * These are intended for operator debugging and post-mortem analysis.
 */
export const cloudJobEventSources = [
  'job_lifecycle',
  'worker_runtime',
  'sleep_check',
  'compute_provider',
  'machine_oidc',
  'snapshot_request',
  'snapshot_queue',
  'snapshot_resume',
] as const;

export type CloudJobEventSource = (typeof cloudJobEventSources)[number];

/**
 * Durable event categories for cloud job audit history.
 *
 * Rich decision metadata lives in the accompanying JSON details so callers can
 * extend the shape without a schema change for every new branch reason.
 */
export const cloudJobEventTypes = [
  'decision',
  'enqueued',
  'started',
  'completed',
  'failed',
  'phase',
] as const;

export type CloudJobEventType = (typeof cloudJobEventTypes)[number];

export type CloudJobEventDetails = Record<string, unknown>;

export const computeProviderLaunchModes = [
  'fresh',
  'environment_snapshot',
  'task_snapshot',
] as const;

export type ComputeProviderLaunchMode =
  (typeof computeProviderLaunchModes)[number];

export const computeProviderMutationOperations = [
  'create_instance',
  'resume_from_snapshot',
  'destroy_instance',
  'write_files',
  'run_command',
  'create_snapshot',
] as const;

export type ComputeProviderMutationOperation =
  (typeof computeProviderMutationOperations)[number];

export interface ComputeProviderMutationEvent {
  provider: ComputeProvider;
  operation: ComputeProviderMutationOperation;
  eventType: Extract<CloudJobEventType, 'started' | 'completed' | 'failed'>;
  instanceId?: string;
  message?: string;
  details?: CloudJobEventDetails;
}

export type ComputeProviderMutationObserver = (
  event: ComputeProviderMutationEvent,
) => Promise<void> | void;

/**
 * CloudTask
 */

const sharedTaskSchema = z.object({
  userId: z.string().nullish(),
  harness: z.enum(codingHarnesses).optional(),
  computeProvider: z.enum(computeProviders).optional(),
  requestedWorkKindDecision: requestedWorkKindDecisionSchema.optional(),
  attributionOverride: z
    .object({
      kind: z.literal('automatic'),
      sourceKind: z.enum(TASK_ATTRIBUTION_SOURCE_KINDS).optional(),
      /** User-facing automation name for attribution/analytics. */
      displayName: z.string().min(1).optional(),
    })
    .optional(),
  /**
   * Optional top-level Slack thread linkage for atomic persistence on the
   * initial cloud_jobs insert. Slack-specific callers still keep any payload
   * thread metadata they need for prompt assembly or callbacks.
   */
  slackThreadTs: z.string().nullish(),

  githubLogin: z.string().nullish(),
  githubUserId: z.number().nullish(),

  // PR-specific fields:
  prSourceControlProvider: sourceControlProviderSchema.nullish(),
  prRepo: z.string().nullish(),
  prNumber: z.number().nullish(),
  prSha: z.string().nullish(),
  githubPrReactionId: z.number().nullish(),
  githubPrReviewCommentId: z.number().nullish(),

  // Resume-from-snapshot fields (set at insert time for atomic duplicate detection):
  sourceSnapshotId: z.string().nullish(),
  sourceCloudJobId: z.number().nullish(),
});

export const linkedWorkItemProviderSchema = z.enum([
  'github',
  'gitlab',
  'linear',
  'jira',
  'asana',
]);

export const linkedWorkItemSchema = z.object({
  provider: linkedWorkItemProviderSchema,
  identifier: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  /**
   * Repository full name in owner/repo format when the provider's reference
   * syntax needs repository scoping, such as GitHub cross-repository issues.
   */
  repository: z.string().optional(),
});

export type LinkedWorkItem = z.infer<typeof linkedWorkItemSchema>;

/**
 * Base payload fields shared by all task types.
 * The `repo` field is always required for backwards compatibility with
 * single-repository task plumbing.
 * Optionally, an `environmentId` can be provided to use a multi-repository
 * workspace configuration. When using environments, the `repo` field is ignored
 * (but still populated for backwards compatibility).
 */
const sharedTaskPayloadSchema = z.object({
  /**
   * Legacy single-repository field in owner/repo format, or the
   * ALL_REPOSITORIES sentinel for shared multi-repository workspaces.
   */
  repo: z.string(),

  /**
   * Source-control provider for repository and pull request fields. Existing
   * GitHub-backed payloads omit this field and default to GitHub at runtime.
   */
  sourceControlProvider: sourceControlProviderSchema.optional(),

  /**
   * Per-launch PR delivery override. When present, pull requests created for
   * this job derive their draft/ready state from this action instead of the
   * deployment-wide PR delivery setting. Omitted for launches that follow the
   * deployment default.
   */
  prAction: z.enum(prActions).optional(),

  /**
   * Deprecated legacy PR keys retained so historical jsonb payloads written
   * before the provider-neutral rename still validate and remain readable.
   * Writers emit only the `pr*` keys; readers should prefer those and fall
   * back to these only for pre-rename rows.
   */
  githubPrRepo: z.string().optional(),
  githubPrNumber: z.number().optional(),
  githubPrSha: z.string().optional(),

  /**
   * Whether the user-facing session prompt synthesized from this payload
   * should appear in the transcript. Omitted defaults to visible.
   */
  visibleInTranscript: z.boolean().optional(),

  /**
   * Branch to checkout for legacy single-repository workspace selection.
   * When using environments, this is ignored.
   */
  branch: z.string().optional(),

  /**
   * Specific commit SHA to pin checkout for legacy single-repository
   * workspace selection.
   * When provided, worker checkout will reset to this commit after branch setup.
   */
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional(),

  /**
   * Environment ID for multi-repository workspace configuration.
   * When specified, additional repositories defined in the environment
   * will be cloned alongside the primary repository.
   */
  environmentId: z.string().uuid().optional(),

  /**
   * Optional environment definition ID for setup/update tasks that should be
   * associated with an environment record without changing workspace selection.
   */
  environmentDefinitionId: z.string().uuid().optional(),

  /**
   * Optional validated repository subset to prepare when `repo` is the
   * ALL_REPOSITORIES sentinel. This allows multi-repo tasks to start a shared
   * workspace without cloning every active repository in the organization.
   */
  selectedRepositories: z.array(z.string()).min(1).optional(),

  // We can eventually use the full Roomote settings here.
  configuration: z
    .object({
      mode: z.string().optional(),
    })
    .optional(),

  // Optional port for preview environments (routes to sandbox vendor).
  port: z.number().min(1024).max(65535).optional(),

  /**
   * Optional per-task override for the model reasoning effort used at runtime.
   * When omitted, workers fall back to the default task reasoning effort.
   */
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),

  /**
   * Hidden launch-time harness model overrides used for controlled deployment-level
   * next-model testing. Only populated when a launcher explicitly opts a task
   * into a harness-specific model override.
   */
  harnessModelOverrides: z
    .object({
      'opencode-server': openCodeModelOverrideSchema.optional(),
    })
    .optional(),

  /**
   * Optional provider-neutral work-item references that PR-delivery workflows
   * can render into provider-specific closing or reference syntax.
   */
  linkedWorkItems: z.array(linkedWorkItemSchema).optional(),

  /**
   * Optional provider-neutral routing metadata for task types that still own a
   * chat thread. Slack-specific aliases are kept below for older payloads.
   */
  communicationProvider: communicationProviderSchema.optional(),
  communicationTeamId: z.string().optional(),
  communicationTeamDomain: z.string().optional(),
  communicationServiceUrl: z.string().optional(),
  communicationChannelId: z.string().optional(),
  communicationThreadId: z.string().optional(),
  communicationMessageId: z.string().optional(),

  /**
   * Optional Slack routing metadata for non-Slack task types that still own a
   * Slack thread, such as background automation summary threads.
   */
  channel: z.string().optional(),
  slackChannel: z.string().optional(),
  teamId: z.string().optional(),
  slackTeamId: z.string().optional(),
  teamDomain: z.string().optional(),
  slackTeamDomain: z.string().optional(),
  thread_ts: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackConversationUrl: z.string().url().optional(),

  /**
   * Optional Teams routing metadata. Teams handlers should prefer the
   * provider-neutral fields above and populate these aliases only when they
   * need provider-specific Graph or Bot Framework identifiers.
   */
  teamsTeamId: z.string().optional(),
  teamsTenantId: z.string().optional(),
  teamsServiceUrl: z.string().optional(),
  teamsChannelId: z.string().optional(),
  teamsConversationId: z.string().optional(),
  teamsThreadId: z.string().optional(),
  teamsMessageId: z.string().optional(),

  /**
   * Optional automation work item marker for late-bound automation execution
   * tasks. Its presence authorizes the Slack thread-reply MCP endpoint to
   * create a top-level channel root message for channel-only jobs, so it must
   * survive schema parsing rather than being stripped as an unknown key.
   */
  automationWorkItemId: z.string().optional(),
});

const queuedSnapshotResumeSlackMessageSchema = z.object({
  text: z.string(),
  user: z.string(),
  userId: z.string().optional(),
  ts: z.string(),
  images: z.array(z.string()).optional(),
  formattedPrompt: z.string().optional(),
  turnPolicy: z
    .object({
      reactionsAllowed: z.boolean().optional(),
    })
    .optional(),
  contextOnly: z.boolean().optional(),
});

const queuedSnapshotResumeLinearMessageSchema = z.object({
  sessionId: z.string(),
  organizationId: z.string(),
  action: z.enum(['created', 'create', 'prompted']),
  payload: z.unknown(),
  userId: z.string().optional(),
  timestamp: z.number(),
});

const queuedSnapshotResumeCommunicationMessageSchema =
  queuedCommunicationMessageSchema.extend({
    provider: communicationProviderSchema,
  });

export const githubIssueFixSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.GithubIssueFix),
  payload: sharedTaskPayloadSchema.extend({
    issue: z.number(),
    title: z.string(),
    body: z.string(),
    instructions: z.string().optional(),
  }),
});

export type GithubIssueFixTask = z.infer<typeof githubIssueFixSchema>;

export const githubIssueCommentSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.GithubIssueCommentRespond),
  payload: sharedTaskPayloadSchema.extend({
    issueNumber: z.number(),
    issueTitle: z.string(),
    issueBody: z.string(),
    commentId: z.number(),
    commentBody: z.string(),
    commentAuthor: z.string(),
  }),
});

export type GithubIssueCommentTask = z.infer<typeof githubIssueCommentSchema>;

const githubPullRequestReviewFollowUpSourceSchema = z
  .enum(['explicit_fix', 'github_mention'])
  .transform(() => 'github_mention' as const);

const githubPullRequestReviewFollowUpPayloadSchema =
  sharedTaskPayloadSchema.extend({
    prNumber: z.number(),
    prTitle: z.string(),
    commentId: z.number().optional(),
    commentBody: z.string(),
    followUpSource: githubPullRequestReviewFollowUpSourceSchema.optional(),
  });

const snapshotResumePromptFallbackTaskSchema = z.object({
  type: z.literal(CloudTaskType.GithubPrReviewFollowUp),
  userId: z.string().optional(),
  githubLogin: z.string().optional(),
  githubUserId: z.number().optional(),
  payload: githubPullRequestReviewFollowUpPayloadSchema,
});

export const githubPullRequestReviewFollowUpSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.GithubPrReviewFollowUp),
  payload: githubPullRequestReviewFollowUpPayloadSchema,
});

export type GithubPullRequestReviewFollowUpTask = z.infer<
  typeof githubPullRequestReviewFollowUpSchema
>;

export const githubPullRequestReviewOpenSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.GithubPrReview),
  payload: sharedTaskPayloadSchema.extend({
    prNumber: z.number(),
    prTitle: z.string(),
    prUrl: z.string(),
    headSha: z.string(),
    branchName: z.string().optional(),
    targetBranch: z.string().optional(),
    relayReviewResultsToTask: z.boolean().optional(),
    linkedTaskId: z.string().optional(),
    linkedTaskRelayLookupPending: z.boolean().optional(),
  }),
});

export type GithubPullRequestReviewOpenTask = z.infer<
  typeof githubPullRequestReviewOpenSchema
>;

export const githubPullRequestReviewSyncSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.GithubPrReviewSync),
  payload: sharedTaskPayloadSchema.extend({
    prNumber: z.number(),
    prTitle: z.string(),
    prUrl: z.string(),
    headSha: z.string(),
    branchName: z.string().optional(),
    targetBranch: z.string().optional(),
    relayReviewResultsToTask: z.boolean().optional(),
    linkedTaskId: z.string().optional(),
    linkedTaskRelayLookupPending: z.boolean().optional(),
  }),
});

export type GithubPullRequestReviewSyncTask = z.infer<
  typeof githubPullRequestReviewSyncSchema
>;

export const githubPrConflictResolveSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.GithubPrConflictResolve),
  payload: sharedTaskPayloadSchema.extend({
    prNumber: z.number(),
    prTitle: z.string(),
    prUrl: z.string(),
    headRef: z.string(),
    baseRef: z.string(),
  }),
});

export type GithubPrConflictResolveTask = z.infer<
  typeof githubPrConflictResolveSchema
>;

export const workspaceReadinessSchema = z.enum([
  'environment_backed',
  'bare_repo',
]);

export type WorkspaceReadiness = z.infer<typeof workspaceReadinessSchema>;

export const slackAppMentionSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.SlackAppMention),
  payload: sharedTaskPayloadSchema.extend({
    channel: z.string(),
    teamId: z.string().optional(),
    user: z.string().optional(),
    text: z.string(),
    agentPromptText: z.string().optional(),
    /**
     * Optional acknowledgement emoji name that was applied to the source
     * message when the task was kicked off.
     */
    ackEmoji: z.string().optional(),
    /**
     * Optional completion emoji name captured when the task was kicked off.
     */
    completionEmoji: z.string().optional(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    images: z.array(z.string()).optional(),
    webPath: z.string().optional(),
    workspaceReadiness: workspaceReadinessSchema.optional(),
    readinessMessage: z.string().optional(),
    threadMessages: z
      .array(
        z.object({
          user: z.string(),
          username: z.string().optional(),
          text: z.string(),
          ts: z.string(),
          bot_id: z.string().optional(),
          type: z.string(),
        }),
      )
      .optional(),
    latestOwnBotReplyText: z.string().optional(),
    latestOwnBotReplyTs: z.string().optional(),
  }),
});

export type SlackAppMentionTask = z.infer<typeof slackAppMentionSchema>;

export const linearAgentSessionSchema = sharedTaskSchema
  .omit({ githubLogin: true, githubUserId: true })
  .extend({
    type: z.literal(CloudTaskType.LinearAgentSession),
    linearSessionId: z.string(),
    linearIssueId: z.string().optional(),
    linearOrganizationId: z.string(),
    payload: sharedTaskPayloadSchema.extend({
      sessionId: z.string(),
      organizationId: z.string(),
      action: z.enum(['created', 'create', 'prompted']),
      issueId: z.string(),
      issueIdentifier: z.string(),
      issueTitle: z.string(),
      issueDescription: z.string().optional(),
      issueUrl: z.string(),
      commentBody: z.string().optional(),
      commentId: z.string().optional(),
      userId: z.string().optional(),
      username: z.string().optional(),
      previousComments: z
        .array(
          z.object({
            id: z.string(),
            body: z.string(),
            userId: z.string().optional(),
            username: z.string().optional(),
            createdAt: z.string().optional(),
          }),
        )
        .optional(),
      guidance: z
        .object({
          system: z.string().optional(),
          instructions: z.string().optional(),
        })
        .optional(),
    }),
  });

export type LinearAgentSessionTask = z.infer<typeof linearAgentSessionSchema>;

const standardTaskBootstrapSchema = z
  .object({
    /**
     * Optional explicit packaged-skill bootstrap for persisted StandardTask
     * rows that must preserve a non-default entry path without altering the
     * user-visible task description.
     */
    skill: z.enum(['explain-repo-code', 'plan-repo-implementation']).optional(),
    /**
     * Optional hidden default-mode override for persisted StandardTask rows.
     * This keeps interactive bootstrap behavior out of visible prompt text.
     */
    interactiveMode: z.boolean().optional(),
  })
  .optional();

const delegatedTaskPayloadSchema = sharedTaskPayloadSchema.extend({
  description: z.string().optional(),
  images: z.array(z.string()).optional(),
  blank: z.boolean().optional(),
  bootstrap: standardTaskBootstrapSchema,
});

export const standardTaskSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.StandardTask),
  payload: delegatedTaskPayloadSchema,
});

export type StandardTask = z.infer<typeof standardTaskSchema>;

const suggestedTasksPayloadSchema = delegatedTaskPayloadSchema.extend({
  trigger: z.enum(['onboarding', 'scheduled']).optional(),
  notifySlack: z.boolean().optional(),
  suggestionSource: z.enum(TASK_SUGGESTION_SOURCES).optional(),
  historicalThreadFeedbackDebugSnippet: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional(),
  selectedRepositoryIds: z.array(z.string().uuid()).min(1).optional(),
});

export const suggestedTasksTaskSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.SuggestedTasks),
  payload: suggestedTasksPayloadSchema,
});

export type SuggestedTasksTask = z.infer<typeof suggestedTasksTaskSchema>;

const currentMcpConfigSchema = z.object({
  enabledIntegrationIds: z.array(z.string()).optional(),
  configuredCustomServerIds: z.array(z.string()).optional(),
  configuredWorkspaceServerIds: z.array(z.string()).optional(),
});

const mcpRecommendationsPayloadSchema = delegatedTaskPayloadSchema.extend({
  sourceTaskId: z.string().trim().min(1),
  slackChannel: z.string().trim().min(1),
  installerUserId: z.string().trim().min(1).optional(),
  currentConfig: currentMcpConfigSchema.optional(),
});

export const mcpRecommendationsTaskSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.McpRecommendations),
  payload: mcpRecommendationsPayloadSchema,
});

export type McpRecommendationsTask = z.infer<
  typeof mcpRecommendationsTaskSchema
>;

const legacyOnboardingSuggestionsTaskSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.LegacyOnboardingSuggestions),
  payload: suggestedTasksPayloadSchema,
});

export const snapshotEnvironmentAttachmentSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') {
      return value;
    }

    const attachment = value as {
      source?: unknown;
      sourceSnapshotId?: unknown;
      sourceSnapshotCreatedAt?: unknown;
    };

    if (
      attachment.source === 'active_snapshot_row' &&
      !('sourceSnapshotId' in attachment) &&
      !('sourceSnapshotCreatedAt' in attachment)
    ) {
      return {
        ...attachment,
        source: 'legacy_active_snapshot_row',
      };
    }

    return value;
  },
  z.discriminatedUnion('source', [
    z.object({
      source: z.literal('active_snapshot_row'),
      environmentSnapshotId: z.string().uuid(),
      sourceSnapshotId: z.string().nullable(),
      sourceSnapshotCreatedAt: z.string().datetime().nullable(),
    }),
    z.object({
      source: z.literal('pending_snapshot_row'),
      environmentSnapshotId: z.string().uuid(),
      claimedAt: z.string().datetime(),
    }),
    z.object({
      source: z.literal('legacy_active_snapshot_row'),
      environmentSnapshotId: z.string().uuid(),
    }),
    z.object({
      source: z.literal('legacy_sandbox_row'),
      legacySnapshotId: z.string().min(1),
    }),
  ]),
);

export type SnapshotEnvironmentAttachment = z.infer<
  typeof snapshotEnvironmentAttachmentSchema
>;

/**
 * SnapshotEnvironment
 *
 * Creates a base snapshot for an environment by running setup steps
 * (clone repos, start services, run setup commands) and then taking
 * a Vercel Sandbox snapshot. The snapshot can be used to speed up
 * subsequent cloud jobs using this environment.
 */
export const snapshotEnvironmentSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.SnapshotEnvironment),
  payload: sharedTaskPayloadSchema.omit({ environmentId: true }).extend({
    /**
     * The environment ID to create a snapshot for.
     * The environment config defines which repositories, services,
     * and setup commands to include in the snapshot.
     */
    environmentId: z.string().uuid(),
    environmentSnapshotAttachment:
      snapshotEnvironmentAttachmentSchema.optional(),
  }),
});

export type SnapshotEnvironmentTask = z.infer<typeof snapshotEnvironmentSchema>;

/**
 * SnapshotResume
 *
 * Creates a new cloud job that starts from a previously captured snapshot.
 * This allows users to continue work from where a previous job left off,
 * or to use a pre-configured environment snapshot for faster startup.
 */
export const snapshotResumeSchema = sharedTaskSchema.extend({
  type: z.literal(CloudTaskType.SnapshotResume),
  // Optional Linear metadata for snapshot resumes triggered by Linear follow-ups.
  linearSessionId: z.string().optional(),
  linearIssueId: z.string().optional(),
  linearOrganizationId: z.string().optional(),
  // Optional Slack metadata for snapshot resumes triggered by Slack follow-ups.
  slackThreadTs: z.string().nullish(),
  payload: sharedTaskPayloadSchema.extend({
    /**
     * The Vercel Sandbox snapshot ID to resume from.
     */
    sourceSnapshotId: z.string(),
    /**
     * The cloud job ID that created the snapshot.
     * Required to look up the source job's configuration (port, environmentId).
     */
    sourceCloudJobId: z.number(),
    /**
     * Optional canonical Slack channel ID copied onto resumed Slack-linked jobs.
     * Shared Slack routing consumers should prefer this field when present.
     */
    channel: z.string().optional(),
    /**
     * Optional Slack channel ID for snapshot resumes triggered by Slack follow-ups.
     * Legacy alias preserved for compatibility with older resume rows and
     * callers that still read `payload.slackChannel`.
     */
    slackChannel: z.string().optional(),
    /**
     * Optional canonical Slack thread timestamp copied onto resumed Slack-linked
     * jobs so shared routing helpers can read thread context from the payload.
     */
    thread_ts: z.string().optional(),
    /**
     * Optional Slack message ts for the follow-up message that triggered the
     * resume. Used to clear transient acknowledgement reactions once the
     * resumed worker starts.
     */
    slackOriginMessageTs: z.string().optional(),
    /**
     * Optional acknowledgement emoji name that was applied to the follow-up
     * Slack message when the resume was queued.
     */
    ackEmoji: z.string().optional(),
    /**
     * Optional completion emoji name captured when the resume was queued.
     */
    completionEmoji: z.string().optional(),
    /**
     * Optional deferred follow-up prompt that should be sent from inside the
     * resumed worker once the harness session is ready.
     */
    resumePrompt: z.string().optional(),
    /**
     * Optional logical source label for the deferred follow-up prompt.
     */
    resumePromptSource: z.string().optional(),
    /**
     * Optional client message id that should be preserved when the deferred
     * follow-up prompt is delivered inside the resumed worker.
     */
    resumePromptClientMessageId: z.string().optional(),
    /**
     * Optional user ID that should become the acting user before the deferred
     * follow-up prompt is sent.
     */
    resumePromptUserId: z.string().optional(),
    /**
     * Optional image attachments for the deferred follow-up prompt. Kept
     * separate from visible prompt fields so resume handoff does not inherit
     * stale source-job images.
     */
    resumePromptImages: z.array(z.string()).optional(),
    /**
     * Optional Slack follow-up messages drained from the source job while a
     * SnapshotResume request is waiting in the product queue. The resumed
     * worker delivers these once the harness session is ready.
     */
    queuedSlackMessages: z
      .array(queuedSnapshotResumeSlackMessageSchema)
      .optional(),
    /**
     * Optional provider-neutral follow-up messages drained from the source job
     * while a SnapshotResume request is waiting in the product queue. New chat
     * providers should use this instead of adding provider-specific arrays.
     */
    queuedCommunicationMessages: z
      .array(queuedSnapshotResumeCommunicationMessageSchema)
      .optional(),
    /**
     * Optional Linear follow-up messages drained from the source job while a
     * SnapshotResume request is waiting in the product queue. The resumed
     * worker delivers these once the harness session is ready.
     */
    queuedLinearMessages: z
      .array(queuedSnapshotResumeLinearMessageSchema)
      .optional(),
    /**
     * Optional dedicated follow-up task that can be started later if the
     * deferred resume prompt is never accepted.
     */
    resumePromptFallbackTask: snapshotResumePromptFallbackTaskSchema.optional(),
    /**
     * Optional visible prompt fields copied forward from the source job so
     * repeated sleep/wake cycles can keep showing the same user-facing prompt.
     */
    description: z.string().optional(),
    text: z.string().optional(),
    commentBody: z.string().optional(),
    images: z.array(z.string()).optional(),
  }),
});

export type SnapshotResumeTask = z.infer<typeof snapshotResumeSchema>;
export type SnapshotResumePromptFallbackTask = z.infer<
  typeof snapshotResumePromptFallbackTaskSchema
>;

function getNonEmptyTaskPayloadString(
  payload: unknown,
  key: string,
): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const value = (payload as Record<string, unknown>)[key];

  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function getCommunicationProviderFromTaskPayload(
  payload: unknown,
): CommunicationProvider | null {
  const explicitProvider = getNonEmptyTaskPayloadString(
    payload,
    'communicationProvider',
  );

  if (isCommunicationProvider(explicitProvider)) {
    return explicitProvider;
  }

  if (
    getSlackChannelFromTaskPayload(payload) ||
    getSlackThreadTsFromTaskPayload(payload) ||
    getSlackTeamIdFromTaskPayload(payload)
  ) {
    return 'slack';
  }

  if (
    getNonEmptyTaskPayloadString(payload, 'teamsChannelId') ||
    getNonEmptyTaskPayloadString(payload, 'teamsConversationId') ||
    getNonEmptyTaskPayloadString(payload, 'teamsThreadId') ||
    getNonEmptyTaskPayloadString(payload, 'teamsMessageId') ||
    getNonEmptyTaskPayloadString(payload, 'teamsTeamId') ||
    getNonEmptyTaskPayloadString(payload, 'teamsTenantId') ||
    getNonEmptyTaskPayloadString(payload, 'teamsServiceUrl')
  ) {
    return 'teams';
  }

  return null;
}

export function getCommunicationTeamIdFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'communicationTeamId') ??
    getNonEmptyTaskPayloadString(payload, 'teamsTeamId') ??
    getNonEmptyTaskPayloadString(payload, 'teamsTenantId') ??
    getSlackTeamIdFromTaskPayload(payload)
  );
}

export function getCommunicationTeamDomainFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'communicationTeamDomain') ??
    getSlackTeamDomainFromTaskPayload(payload)
  );
}

export function getCommunicationServiceUrlFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'communicationServiceUrl') ??
    getNonEmptyTaskPayloadString(payload, 'teamsServiceUrl')
  );
}

export function getCommunicationTenantIdFromTaskPayload(
  payload: unknown,
): string | null {
  return getNonEmptyTaskPayloadString(payload, 'teamsTenantId');
}

export function getCommunicationChannelFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'communicationChannelId') ??
    getNonEmptyTaskPayloadString(payload, 'teamsConversationId') ??
    getNonEmptyTaskPayloadString(payload, 'teamsChannelId') ??
    getSlackChannelFromTaskPayload(payload)
  );
}

export function getCommunicationThreadIdFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'communicationThreadId') ??
    getNonEmptyTaskPayloadString(payload, 'teamsThreadId') ??
    getNonEmptyTaskPayloadString(payload, 'teamsMessageId') ??
    getSlackThreadTsFromTaskPayload(payload)
  );
}

export function getCommunicationMessageIdFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'communicationMessageId') ??
    getNonEmptyTaskPayloadString(payload, 'teamsMessageId')
  );
}

export function getSlackChannelFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'channel') ??
    getNonEmptyTaskPayloadString(payload, 'slackChannel')
  );
}

export function getSlackTeamIdFromTaskPayload(payload: unknown): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'teamId') ??
    getNonEmptyTaskPayloadString(payload, 'slackTeamId')
  );
}

export function getSlackTeamDomainFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'teamDomain') ??
    getNonEmptyTaskPayloadString(payload, 'slackTeamDomain')
  );
}

export function getSlackThreadTsFromTaskPayload(
  payload: unknown,
): string | null {
  return (
    getNonEmptyTaskPayloadString(payload, 'thread_ts') ??
    getNonEmptyTaskPayloadString(payload, 'slackThreadTs')
  );
}

export function getSlackConversationUrlFromTaskPayload(
  payload: unknown,
): string | null {
  return getNonEmptyTaskPayloadString(payload, 'slackConversationUrl');
}

export function populateSnapshotResumeSlackMetadata(
  payload: Record<string, unknown>,
  options: {
    sourcePayload?: unknown;
    teamId?: string | null;
    teamDomain?: string | null;
    channel?: string | null;
    threadTs?: string | null;
    conversationUrl?: string | null;
  } = {},
): void {
  const teamId =
    (hasNonEmptyValue(options.teamId ?? undefined) ? options.teamId : null) ??
    getSlackTeamIdFromTaskPayload(options.sourcePayload);

  if (teamId) {
    payload.teamId = teamId;
    payload.slackTeamId = teamId;
  }

  const teamDomain =
    (hasNonEmptyValue(options.teamDomain ?? undefined)
      ? options.teamDomain
      : null) ?? getSlackTeamDomainFromTaskPayload(options.sourcePayload);

  if (teamDomain) {
    payload.teamDomain = teamDomain;
  }

  const channel =
    (hasNonEmptyValue(options.channel ?? undefined) ? options.channel : null) ??
    getSlackChannelFromTaskPayload(options.sourcePayload);

  if (channel) {
    payload.channel = channel;
    payload.slackChannel = channel;
  }

  const threadTs =
    (hasNonEmptyValue(options.threadTs ?? undefined)
      ? options.threadTs
      : null) ?? getSlackThreadTsFromTaskPayload(options.sourcePayload);

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  const conversationUrl =
    (hasNonEmptyValue(options.conversationUrl ?? undefined)
      ? options.conversationUrl
      : null) ?? getSlackConversationUrlFromTaskPayload(options.sourcePayload);

  if (conversationUrl) {
    payload.slackConversationUrl = conversationUrl;
  }
}

export function populateSnapshotResumeCommunicationMetadata(
  payload: Record<string, unknown>,
  options: {
    provider?: CommunicationProvider | null;
    sourcePayload?: unknown;
    teamId?: string | null;
    teamDomain?: string | null;
    serviceUrl?: string | null;
    channelId?: string | null;
    threadId?: string | null;
    messageId?: string | null;
  } = {},
): void {
  const provider =
    options.provider ??
    getCommunicationProviderFromTaskPayload(options.sourcePayload);

  if (provider) {
    payload.communicationProvider = provider;
  }

  const teamId =
    (hasNonEmptyValue(options.teamId ?? undefined) ? options.teamId : null) ??
    getCommunicationTeamIdFromTaskPayload(options.sourcePayload);

  if (teamId) {
    payload.communicationTeamId = teamId;
  }

  const teamDomain =
    (hasNonEmptyValue(options.teamDomain ?? undefined)
      ? options.teamDomain
      : null) ??
    getCommunicationTeamDomainFromTaskPayload(options.sourcePayload);

  if (teamDomain) {
    payload.communicationTeamDomain = teamDomain;
  }

  const serviceUrl =
    (hasNonEmptyValue(options.serviceUrl ?? undefined)
      ? options.serviceUrl
      : null) ??
    getCommunicationServiceUrlFromTaskPayload(options.sourcePayload);

  if (serviceUrl) {
    payload.communicationServiceUrl = serviceUrl;
  }

  const channelId =
    (hasNonEmptyValue(options.channelId ?? undefined)
      ? options.channelId
      : null) ?? getCommunicationChannelFromTaskPayload(options.sourcePayload);

  if (channelId) {
    payload.communicationChannelId = channelId;
  }

  const threadId =
    (hasNonEmptyValue(options.threadId ?? undefined)
      ? options.threadId
      : null) ?? getCommunicationThreadIdFromTaskPayload(options.sourcePayload);

  if (threadId) {
    payload.communicationThreadId = threadId;
  }

  const messageId =
    (hasNonEmptyValue(options.messageId ?? undefined)
      ? options.messageId
      : null) ??
    getCommunicationMessageIdFromTaskPayload(options.sourcePayload);

  if (messageId) {
    payload.communicationMessageId = messageId;
  }
}

/**
 * Discriminated union of all cloud task schemas.
 * Use this schema for runtime validation of cloud task payloads.
 */
export const cloudTaskSchema = z.discriminatedUnion('type', [
  githubIssueFixSchema,
  githubIssueCommentSchema,
  githubPullRequestReviewFollowUpSchema,
  githubPullRequestReviewOpenSchema,
  githubPullRequestReviewSyncSchema,
  githubPrConflictResolveSchema,
  slackAppMentionSchema,
  linearAgentSessionSchema,
  standardTaskSchema,
  suggestedTasksTaskSchema,
  mcpRecommendationsTaskSchema,
  legacyOnboardingSuggestionsTaskSchema,
  snapshotEnvironmentSchema,
  snapshotResumeSchema,
]);

export type CloudTask = z.infer<typeof cloudTaskSchema>;

/**
 * CloudTaskPayload
 */

export type CloudTaskPayload<T extends CloudTaskType = CloudTaskType> = Extract<
  CloudTask,
  { type: T }
>['payload'];

type CloudTaskWorkspacePayload = {
  repo?: string;
  branch?: string;
  sha?: string;
  environmentId?: string;
  selectedRepositories?: string[];
};

export type CloudTaskWorkspace =
  | {
      type: 'repository';
      repo: string;
      branch?: string;
      sha?: string;
    }
  | {
      type: 'repository_set';
      repositories: string[];
    }
  | {
      type: 'all_repositories';
    }
  | {
      type: 'environment';
      environmentId: string;
      sourceRepo?: string;
      sourceBranch?: string;
      sourceSha?: string;
    };

function normalizeSelectedRepositories(
  repositories?: string[],
): string[] | undefined {
  if (!repositories) {
    return undefined;
  }

  const normalized = [...new Set(repositories.filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveCloudTaskWorkspace(
  payload: CloudTaskWorkspacePayload,
): CloudTaskWorkspace {
  if (payload.environmentId) {
    return {
      type: 'environment',
      environmentId: payload.environmentId,
      sourceRepo: payload.repo,
      sourceBranch: payload.branch,
      sourceSha: payload.sha,
    };
  }

  if (payload.repo === ALL_REPOSITORIES) {
    const repositories = normalizeSelectedRepositories(
      payload.selectedRepositories,
    );

    return repositories
      ? {
          type: 'repository_set',
          repositories,
        }
      : {
          type: 'all_repositories',
        };
  }

  if (!payload.repo) {
    throw new Error(
      'Invalid workspace payload: expected repo or environmentId.',
    );
  }

  return {
    type: 'repository',
    repo: payload.repo,
    branch: payload.branch,
    sha: payload.sha,
  };
}

/**
 * CloudTaskPayload Type Guards
 */

export function isPrReviewJob(
  type: CloudTaskType,
  _payload: CloudTaskPayload,
): _payload is
  | CloudTaskPayload<CloudTaskType.GithubPrReview>
  | CloudTaskPayload<CloudTaskType.GithubPrReviewSync> {
  return (
    type === CloudTaskType.GithubPrReview ||
    type === CloudTaskType.GithubPrReviewSync
  );
}

/**
 * CloudTaskStatus
 */

export enum CloudTaskStatus {
  Pending = 'pending', // Job is created, but not yet dequeued by the controller.
  Dequeued = 'dequeued', // Job is dequeued by the controller but not yet started by the worker.
  Processing = 'processing', // Job is dequeued by the worker.
  Preparing = 'preparing', // Worker is preparing the workspace.
  Spawning = 'spawning', // Worker is spawning the VSCode process.
  Connecting = 'connecting', // Worker is connecting to the VSCode process via IPC.
  Running = 'running', // Worker is running the task.
  Completed = 'completed', // Job completed successfully.
  Failed = 'failed', // Job failed.
  Canceled = 'canceled', // Job was canceled manually.
  Idle = 'idle', // Job is technically completed, but the container is still running and waiting for optional interaction.
}

export const bootingCloudTaskStatuses = [
  CloudTaskStatus.Pending,
  CloudTaskStatus.Dequeued,
  CloudTaskStatus.Processing,
  CloudTaskStatus.Preparing,
  CloudTaskStatus.Spawning,
  CloudTaskStatus.Connecting,
] as const;

export const activeCloudTaskStatuses = [
  ...bootingCloudTaskStatuses,
  CloudTaskStatus.Running,
  CloudTaskStatus.Idle,
] as const;

export const doneCloudTaskStatuses = [
  CloudTaskStatus.Completed,
  CloudTaskStatus.Failed,
  CloudTaskStatus.Canceled,
  CloudTaskStatus.Idle,
] as const;

export const runningCloudTaskStatuses = [
  CloudTaskStatus.Running,
  CloudTaskStatus.Idle,
] as const;

const runningStatuses = new Set<CloudTaskStatus>(runningCloudTaskStatuses);

export const exitedCloudTaskStatuses = [
  CloudTaskStatus.Completed,
  CloudTaskStatus.Failed,
  CloudTaskStatus.Canceled,
] as const;

const exitedStatuses = new Set<CloudTaskStatus>(exitedCloudTaskStatuses);

export const isBootingCloudTaskStatus = (status?: CloudTaskStatus): boolean =>
  !!status && !runningStatuses.has(status) && !exitedStatuses.has(status);

export const isRunningCloudTaskStatus = (status?: CloudTaskStatus): boolean =>
  !!status && runningStatuses.has(status);

export const isExitedCloudTaskStatus = (status?: CloudTaskStatus): boolean =>
  !!status && exitedStatuses.has(status);

/**
 * Task phases reported by the worker's HarnessManager.
 * These represent the internal state of the agent within a running container.
 *
 * - idle: No task is running yet (initial state).
 * - running: Agent is actively working.
 * - waiting_for_prompt: Task completed, waiting for user follow-up.
 * - waiting_for_user_input: Agent is waiting for user input.
 * - stopped: Task was stopped by user.
 * - shutting_down: Keepalive expired, container shutting down.
 */
export type TaskPhase =
  | 'idle'
  | 'waiting_for_prompt'
  | 'waiting_for_user_input'
  | 'running'
  | 'stopped'
  | 'shutting_down';

export const TASK_PHASES: readonly TaskPhase[] = [
  'idle',
  'waiting_for_prompt',
  'waiting_for_user_input',
  'running',
  'stopped',
  'shutting_down',
] as const;

export type TaskStateEvent = 'taskStarted' | 'taskCompleted' | 'taskAborted';

export interface TaskStatusEvent {
  phase: TaskPhase;
  taskStateEvent: TaskStateEvent | null;
  sessionId: string | undefined;
  isConnected: boolean;
  sleepRemainingMs: number | null;
  lastErrorMessage: string | undefined;
}

/**
 * Phases where the agent is actively working on a turn. Used for UI "running"
 * badge counts where `waiting_for_user_input` should read as paused, not busy.
 */
export const WORKING_TASK_PHASES = new Set<TaskPhase>(['running']);

/**
 * Phases where the task is live in the harness loop and consuming sandbox
 * resources -- either executing a turn or blocked on a user-input prompt.
 * Used by the worker (cancel/steer/keepalive gating) and the sleep reaper.
 */
export const ACTIVE_TASK_PHASES = new Set<TaskPhase>([
  'running',
  'waiting_for_user_input',
]);

export function isActiveTaskPhase(phase: TaskPhase): boolean {
  return ACTIVE_TASK_PHASES.has(phase);
}

/**
 * Returns true when the cloud task is actively consuming attention -- either
 * still booting or the agent is actively working.  Use this to drive loading
 * indicators and "running" badge counts instead of relying solely on
 * CloudTaskStatus.
 *
 * The `taskPhase` column is populated by the worker once the job reaches
 * the Running status.  For older jobs that never set a phase we fall back
 * to the legacy behaviour (treat Running status as active).
 */
export function isActivelyRunningCloudTask(
  status?: CloudTaskStatus | null,
  taskPhase?: string | null,
): boolean {
  if (!status) {
    return false;
  }

  // Exited jobs are never active.
  if (exitedStatuses.has(status)) {
    return false;
  }

  // Booting jobs (Pending → Connecting) are always active.
  if (isBootingCloudTaskStatus(status)) {
    return true;
  }

  // Idle status means the job completed (container still alive for keepalive).
  if (status === CloudTaskStatus.Idle) {
    return false;
  }

  // Running status: check the task phase.
  if (status === CloudTaskStatus.Running) {
    // No phase info yet (still initialising or legacy job) → treat as active.
    if (!taskPhase) {
      return true;
    }

    return WORKING_TASK_PHASES.has(taskPhase as TaskPhase);
  }

  return false;
}

/**
 * Returns true when the cloud task is busy executing a turn, or booting
 * toward one.
 *
 * Unlike {@link isActivelyRunningCloudTask}, which drives UI "running" badge
 * counts and short-circuits on the Idle status, this treats the
 * worker-reported task phase as the source of truth for live sandboxes: a
 * cloud job row only holds the Running status during its first turn, flips to
 * Idle when that turn completes, and then stays Idle for every follow-up turn
 * on the still-alive sandbox while `taskPhase` toggles between `running` and
 * `waiting_for_prompt`. Use this check when deciding whether it is safe to
 * deliver conversation messages that should only arrive while the task is not
 * mid-turn.
 */
export function isCloudTaskExecutingTurn(
  status?: CloudTaskStatus | null,
  taskPhase?: string | null,
): boolean {
  if (!status) {
    return false;
  }

  // Exited jobs are never mid-turn (terminal transitions also null the phase).
  if (exitedStatuses.has(status)) {
    return false;
  }

  // Booting jobs (Pending → Connecting) are about to execute a turn.
  if (isBootingCloudTaskStatus(status)) {
    return true;
  }

  // Running with no phase info yet (still initialising or legacy job) →
  // treat as mid-turn.
  if (status === CloudTaskStatus.Running && !taskPhase) {
    return true;
  }

  // For live sandboxes (Running or Idle status) the phase is the truth about
  // whether a turn is currently executing.
  return WORKING_TASK_PHASES.has(taskPhase as TaskPhase);
}

/**
 * Pull request lifecycle status, matching GitHub PR states.
 */
export type PullRequestStatus = 'open' | 'draft' | 'merged' | 'closed';
