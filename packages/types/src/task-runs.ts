import { z } from 'zod';

import {
  type ComputeProvider,
  computeProviders,
} from './compute-providers/compute-provider';
import type { BackgroundAutomationKey } from './background-agents';
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
 * Task classification vocabulary.
 *
 * A task is classified at creation on four independent axes:
 * - `workflow`: what kind of work the task performs.
 * - `surface`: which product surface the task was launched from.
 * - `trigger`: what caused the launch.
 * - `visibility`: whether the task shows up in user-facing task lists.
 *
 * The runtime payload dispatch lives on runs as `payloadKind`
 * (see {@link TaskPayloadKind}). Queries must never branch on payloadKind;
 * they use workflow/surface/visibility.
 */

export const TASK_WORKFLOWS = [
  'standard',
  'pr_review',
  'pr_conflict_resolve',
  'scan',
  'mcp_recommendations',
  'setup_onboarding',
  'env_snapshot',
  'eval',
] as const;

export type TaskWorkflow = (typeof TASK_WORKFLOWS)[number];

/**
 * Source-control automation workflows accepted by webhook routing gates.
 * These are workflow discriminators, not persisted agent identities. Keep this
 * list in lockstep with any attach-to-existing-PR product behavior.
 */
export const SOURCE_CONTROL_AUTOMATION_WORKFLOWS = [
  'pr_review',
  'pr_conflict_resolve',
] as const satisfies ReadonlyArray<TaskWorkflow>;

export type SourceControlAutomationWorkflow =
  (typeof SOURCE_CONTROL_AUTOMATION_WORKFLOWS)[number];

export const TASK_SURFACES = [
  'web',
  'api',
  'slack',
  'teams',
  'telegram',
  'discord',
  'linear',
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
  'system',
] as const;

export type TaskSurface = (typeof TASK_SURFACES)[number];

export const TASK_TRIGGERS = [
  'message',
  'webhook',
  'schedule',
  'manual',
] as const;

export type TaskTrigger = (typeof TASK_TRIGGERS)[number];

export const TASK_VISIBILITIES = ['visible', 'hidden'] as const;

export type TaskVisibility = (typeof TASK_VISIBILITIES)[number];

export const TASK_STATES = [
  'active',
  'completed',
  'failed',
  'canceled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const RUN_KINDS = ['fresh', 'resume'] as const;

export type RunKind = (typeof RUN_KINDS)[number];

export const TASK_INITIATOR_KINDS = ['user', 'automation'] as const;

export type TaskInitiatorKind = (typeof TASK_INITIATOR_KINDS)[number];

export const COMMIT_AUTHOR_KINDS = ['roomote', 'user', 'external'] as const;

export type CommitAuthorKind = (typeof COMMIT_AUTHOR_KINDS)[number];

/**
 * TaskInitiator
 *
 * Launch-time initiator input. Stamped immutably onto the task row at
 * creation (initiatorKind/initiatorUserId/initiatorAutomation/
 * actorExternalId/actorDisplayName). Resumes never re-attribute.
 */
export type TaskInitiator =
  | { kind: 'user'; userId: string }
  | {
      kind: 'user';
      externalId: string;
      displayName?: string;
      matchedUserId?: string;
    }
  | {
      kind: 'automation';
      key: BackgroundAutomationKey;
      actor?: { externalId: string; displayName?: string };
    };

/**
 * Resolve the Roomote user linked to a task initiator, or null when the
 * launch has no resolved human (automation initiators and unmapped external
 * senders).
 *
 * This value seeds `task_runs.actingUserId`, which drives actor-scoped
 * credential resolution (user API keys, user MCP connections, MCP proxy
 * actor checks), so launch paths must derive it through this single helper
 * rather than re-implementing the initiator-shape logic.
 */
export function getTaskInitiatorLinkedUserId(
  initiator: TaskInitiator,
): string | null {
  if (initiator.kind === 'automation') {
    return null;
  }

  if ('userId' in initiator) {
    return initiator.userId;
  }

  return initiator.matchedUserId ?? null;
}

/**
 * TaskPayloadKind
 *
 * Runtime payload dispatch key for task runs. This only
 * selects which payload shape and worker/controller dispatch path a run uses.
 * Query-load-bearing classification lives on tasks as
 * workflow/surface/trigger/visibility.
 */
export const TaskPayloadKind = {
  StandardTask: 'standard',
  Scan: 'scan',
  McpRecommendations: 'mcp_recommendations',
  SlackAppMention: 'slack_app_mention',
  LinearAgentSession: 'linear_agent_session',
  GithubPrReview: 'github_pr_review',
  GithubPrReviewSync: 'github_pr_review_sync',
  GithubPrReviewFollowUp: 'github_pr_review_follow_up',
  GithubPrConflictResolve: 'github_pr_conflict_resolve',
  SnapshotEnvironment: 'snapshot_environment',
  SnapshotResume: 'snapshot_resume',
} as const;

export type TaskPayloadKind =
  (typeof TaskPayloadKind)[keyof typeof TaskPayloadKind];

export type SuggestionCategory =
  | 'bug'
  | 'security'
  | 'chore'
  | 'feature'
  | 'improvement';

export type SuggestionPriority = 'P0' | 'P1' | 'P2' | 'P3';
export const TASK_SUGGESTION_SOURCES = [
  'suggest_ideas',
  'sentry_triage',
  'dependabot_triage',
  'codeql_triage',
  'security_auditor',
  'code_quality_auditor',
  'ci_failure_triage',
] as const;
export type TaskSuggestionSource = (typeof TASK_SUGGESTION_SOURCES)[number];
export const AUTOMATION_WORK_ITEM_DISPOSITIONS = ['suggest', 'act'] as const;
export type AutomationWorkItemDisposition =
  (typeof AUTOMATION_WORK_ITEM_DISPOSITIONS)[number];

/**
 * work_items (Stage 4): one table merges the old task_suggestions,
 * automation_work_items, and setup_new_queued_tasks. `kind` selects the flavor
 * and every launchable surface records its launched task via launchedTaskId.
 */
export const WORK_ITEM_KINDS = [
  'suggestion',
  'auto_fix',
  'onboarding',
  'mcp_recommendation',
] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

/** One launch state machine shared by every work-item kind. */
export const WORK_ITEM_STATUSES = [
  'open',
  'launching',
  'launched',
  'failed',
  'dismissed',
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** Statuses that count as live for fingerprint dedup and launch claims. */
export const WORK_ITEM_ACTIVE_STATUSES: readonly WorkItemStatus[] = [
  'open',
  'launching',
  'launched',
] as const;

/**
 * tracked_messages (Stage 4): the registry of chat messages Roomote posted for
 * a work item or automation. Pure registry — launch state lives on work_items.
 */
export const TRACKED_MESSAGE_SURFACES = [
  'slack',
  'teams',
  'telegram',
  'discord',
] as const;
export type TrackedMessageSurface = (typeof TRACKED_MESSAGE_SURFACES)[number];

export const TRACKED_MESSAGE_KINDS = [
  'suggestion_card',
  'automation_thread',
  'mcp_setup_nudge',
  'announcement',
  'stats_post',
] as const;
export type TrackedMessageKind = (typeof TRACKED_MESSAGE_KINDS)[number];

/**
 * Launch classes used to choose runtime policy for tasks.
 */

export const RUN_LAUNCH_CLASSES = [
  'human',
  'automation',
  'maintenance',
] as const;

export type RunLaunchClass = (typeof RUN_LAUNCH_CLASSES)[number];

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

export const taskPayloadKinds = Object.values(
  TaskPayloadKind,
) as TaskPayloadKind[];

export function isTaskPayloadKind(value: string): value is TaskPayloadKind {
  return taskPayloadKinds.includes(value as TaskPayloadKind);
}

/**
 * Returns true if the given task type should have environment services started.
 * Uses a deny list approach - services are enabled for all types except those
 * that explicitly don't need them.
 */
export function isServicesEnabledTaskPayloadKind(
  _type: TaskPayloadKind,
): boolean {
  return true;
}

const RESUMABLE_PAYLOAD_KINDS: ReadonlySet<TaskPayloadKind> = new Set([
  TaskPayloadKind.StandardTask,
  TaskPayloadKind.Scan,
  TaskPayloadKind.GithubPrReviewFollowUp,
  TaskPayloadKind.SlackAppMention,
  TaskPayloadKind.LinearAgentSession,
  TaskPayloadKind.SnapshotResume,
]);

/**
 * Returns true when a task type should be auto-snapshotted at `sleepAt` and
 * therefore supports resuming from that automatic sleep transition.
 */
export function isResumableTaskPayloadKind(type: TaskPayloadKind): boolean {
  return RESUMABLE_PAYLOAD_KINDS.has(type);
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
 * This applies to app-authored GitHub workflows. Review, review follow-up, and
 * conflict-resolution runs comment on behalf of the app so their feedback is
 * clearly distinguishable from human comments. Without this, linking a GitHub
 * account causes these workflows to masquerade as the user.
 */
export function shouldUseAppTokenOnly(type: TaskPayloadKind): boolean {
  const appTokenOnlyTypes: TaskPayloadKind[] = [
    TaskPayloadKind.GithubPrReview,
    TaskPayloadKind.GithubPrReviewSync,
    TaskPayloadKind.GithubPrReviewFollowUp,
    TaskPayloadKind.GithubPrConflictResolve,
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

export function stripRunErrorMarkers(
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
 * Captures the initial user intent for a task run launch, not the full
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
 * Worker-side liveness heartbeat cadence for sandbox-backed task runs.
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
 * Durable audit sources for task run lifecycle events.
 * These are intended for operator debugging and post-mortem analysis.
 */
export const runEventSources = [
  'run_lifecycle',
  'worker_runtime',
  'sleep_check',
  'compute_provider',
  'machine_oidc',
  'snapshot_request',
  'snapshot_queue',
  'snapshot_resume',
] as const;

export type RunEventSource = (typeof runEventSources)[number];

/**
 * Durable event categories for task run audit history.
 *
 * Rich decision metadata lives in the accompanying JSON details so callers can
 * extend the shape without a schema change for every new branch reason.
 */
export const runEventTypes = [
  'decision',
  'enqueued',
  'started',
  'completed',
  'failed',
  'phase',
  'diagnostic',
] as const;

export type RunEventType = (typeof runEventTypes)[number];

export type RunEventDetails = Record<string, unknown>;

export const computeProviderLaunchModes = [
  'fresh',
  'environment_snapshot',
  'task_snapshot',
  'task_standby',
] as const;

export type ComputeProviderLaunchMode =
  (typeof computeProviderLaunchModes)[number];

export const computeProviderMutationOperations = [
  'create_instance',
  'resume_from_snapshot',
  'enter_standby',
  'resume_from_standby',
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
  eventType: Extract<RunEventType, 'started' | 'completed' | 'failed'>;
  instanceId?: string;
  message?: string;
  details?: RunEventDetails;
}

export type ComputeProviderMutationObserver = (
  event: ComputeProviderMutationEvent,
) => Promise<void> | void;

/**
 * TaskSpec
 */

const sharedTaskSchema = z.object({
  userId: z.string().nullish(),
  harness: z.enum(codingHarnesses).optional(),
  computeProvider: z.enum(computeProviders).optional(),
  requestedWorkKindDecision: requestedWorkKindDecisionSchema.optional(),
  /**
   * Optional top-level Slack thread linkage for atomic persistence on the
   * initial task_runs insert. Slack-specific callers still keep any payload
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
  sourceRunId: z.number().nullish(),
});

export const linkedWorkItemProviderSchema = z.enum([
  'github',
  'gitlab',
  'gitea',
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
   * Source-control instance host for repository resolution (for example
   * `gitlab.example.com`), matching `repositories.host`. Stamped by launch
   * sites that know the concrete host so same-name repositories on multiple
   * hosts resolve unambiguously. Omitted payloads resolve by
   * (provider, fullName) alone.
   */
  sourceControlHost: z.string().optional(),

  /**
   * Per-launch PR delivery override. When present, pull requests created for
   * this run derive their draft/ready state from this action instead of the
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
   * Marks this task as an environment verification flow for the given
   * environment id. Set by the verification-retry command and by the
   * environment-setup skill's follow-up verification task. Only tasks carrying
   * this marker may record a verification result for that environment through
   * the `record_verification` MCP action.
   */
  verifiesEnvironmentId: z.string().uuid().optional(),

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
  communicationGuildId: z.string().optional(),
  communicationServiceUrl: z.string().optional(),
  communicationChannelId: z.string().optional(),
  communicationThreadId: z.string().optional(),
  communicationMessageId: z.string().optional(),
  /** Provider event that caused this fresh launch; used for idempotent retries. */
  communicationSourceEventId: z.string().optional(),
  /**
   * Discord channel hosting the origin reaction target. Always a channel that
   * contains `discordReactionMessageId` (never an interaction id).
   */
  discordReactionChannelId: z.string().optional(),
  /**
   * Discord message id that platform reactions (👀 / terminal / cancel) target.
   * Must be a real message id, never an interaction id.
   */
  discordReactionMessageId: z.string().optional(),
  /**
   * True when intake pinned 👀 on the origin reaction target before launch.
   * Worker onStart clears that eyes reaction only when this flag is set so
   * resume runs and interaction launches without intake eyes do not DELETE 404s.
   */
  discordIntakeAckPending: z.boolean().optional(),
  /** True when the Telegram topic was created specifically for this task. */
  telegramTaskTopic: z.boolean().optional(),
  /** True when the Discord thread/forum post was created for this task. */
  discordTaskThread: z.boolean().optional(),

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
   * create a top-level channel root message for channel-only runs, so it must
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
  type: z.literal(TaskPayloadKind.GithubPrReviewFollowUp),
  userId: z.string().optional(),
  githubLogin: z.string().optional(),
  githubUserId: z.number().optional(),
  payload: githubPullRequestReviewFollowUpPayloadSchema,
});

export const githubPullRequestReviewFollowUpSchema = sharedTaskSchema.extend({
  type: z.literal(TaskPayloadKind.GithubPrReviewFollowUp),
  payload: githubPullRequestReviewFollowUpPayloadSchema,
});

export type GithubPullRequestReviewFollowUpTask = z.infer<
  typeof githubPullRequestReviewFollowUpSchema
>;

export const githubPullRequestReviewOpenSchema = sharedTaskSchema.extend({
  type: z.literal(TaskPayloadKind.GithubPrReview),
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
  type: z.literal(TaskPayloadKind.GithubPrReviewSync),
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
  type: z.literal(TaskPayloadKind.GithubPrConflictResolve),
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
  type: z.literal(TaskPayloadKind.SlackAppMention),
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
    type: z.literal(TaskPayloadKind.LinearAgentSession),
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
  /**
   * Optional agent-facing prompt override. When set, the workflow builds the
   * task prompt from this text (e.g. channel auto-start instructions prepended
   * to the message) while `description` stays the user-visible task text.
   */
  agentPromptText: z.string().optional(),
  images: z.array(z.string()).optional(),
  blank: z.boolean().optional(),
  bootstrap: standardTaskBootstrapSchema,
  /**
   * When true, the platform notifies the launching run (`sourceRunId` on this
   * task's first run) when a run of this task settles. Set at launch time via
   * `notifyOnSettle`; read by the run-finalization path.
   */
  notifySourceRunOnSettle: z.boolean().optional(),
});

export function getNotifySourceRunOnSettleFromPayload(
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  return (payload as Record<string, unknown>).notifySourceRunOnSettle === true;
}

export const standardTaskSchema = sharedTaskSchema.extend({
  type: z.literal(TaskPayloadKind.StandardTask),
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
  type: z.literal(TaskPayloadKind.Scan),
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
  type: z.literal(TaskPayloadKind.McpRecommendations),
  payload: mcpRecommendationsPayloadSchema,
});

export type McpRecommendationsTask = z.infer<
  typeof mcpRecommendationsTaskSchema
>;

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
 * subsequent task runs using this environment.
 */
export const snapshotEnvironmentSchema = sharedTaskSchema.extend({
  type: z.literal(TaskPayloadKind.SnapshotEnvironment),
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
 * Creates a new task run that starts from a previously captured snapshot.
 * This allows users to continue work from where a previous run left off,
 * or to use a pre-configured environment snapshot for faster startup.
 */
export const snapshotResumeSchema = sharedTaskSchema.extend({
  type: z.literal(TaskPayloadKind.SnapshotResume),
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
     * The task run ID that created the snapshot.
     * Required to look up the source run's configuration (port, environmentId).
     */
    sourceRunId: z.number(),
    /**
     * Optional canonical Slack channel ID copied onto resumed Slack-linked runs.
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
     * runs so shared routing helpers can read thread context from the payload.
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
     * stale source-run images.
     */
    resumePromptImages: z.array(z.string()).optional(),
    /**
     * Optional Slack follow-up messages drained from the source run while a
     * SnapshotResume request is waiting in the product queue. The resumed
     * worker delivers these once the harness session is ready.
     */
    queuedSlackMessages: z
      .array(queuedSnapshotResumeSlackMessageSchema)
      .optional(),
    /**
     * Optional provider-neutral follow-up messages drained from the source run
     * while a SnapshotResume request is waiting in the product queue. New chat
     * providers should use this instead of adding provider-specific arrays.
     */
    queuedCommunicationMessages: z
      .array(queuedSnapshotResumeCommunicationMessageSchema)
      .optional(),
    /**
     * Optional Linear follow-up messages drained from the source run while a
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
     * Optional visible prompt fields copied forward from the source run so
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

export function getCommunicationGuildIdFromTaskPayload(
  payload: unknown,
): string | null {
  return getNonEmptyTaskPayloadString(payload, 'communicationGuildId');
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

/**
 * Discord channel + message that intake (👀) and terminal platform reactions
 * target. Prefer the dedicated reaction fields (always real message ids) over
 * communication message metadata, which can lag for interaction launches.
 */
export function getDiscordReactionTargetFromTaskPayload(payload: unknown): {
  channelId: string;
  messageId: string;
} | null {
  const channelId =
    getNonEmptyTaskPayloadString(payload, 'discordReactionChannelId') ??
    getCommunicationChannelFromTaskPayload(payload);
  const messageId =
    getNonEmptyTaskPayloadString(payload, 'discordReactionMessageId') ??
    getCommunicationMessageIdFromTaskPayload(payload);

  if (!channelId || !messageId) {
    return null;
  }

  return { channelId, messageId };
}

/**
 * Origin of a real Discord intake 👀 reaction to clear on worker start.
 * Requires the dedicated reaction target plus the intake-pending flag set at
 * enqueue when eyes were actually pinned (not resume / interaction-only targets).
 */
export function getDiscordIntakeAckReactionTargetFromTaskPayload(
  payload: unknown,
): { channelId: string; messageId: string } | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (
    (payload as { discordIntakeAckPending?: unknown })
      .discordIntakeAckPending !== true
  ) {
    return null;
  }

  const channelId = getNonEmptyTaskPayloadString(
    payload,
    'discordReactionChannelId',
  );
  const messageId = getNonEmptyTaskPayloadString(
    payload,
    'discordReactionMessageId',
  );

  if (!channelId || !messageId) {
    return null;
  }

  return { channelId, messageId };
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
    guildId?: string | null;
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

  const guildId =
    (hasNonEmptyValue(options.guildId ?? undefined) ? options.guildId : null) ??
    getCommunicationGuildIdFromTaskPayload(options.sourcePayload);

  if (guildId) {
    payload.communicationGuildId = guildId;
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
 * Discriminated union of all task schemas.
 * Use this schema for runtime validation of task payloads.
 */
export const taskSpecSchema = z.discriminatedUnion('type', [
  githubPullRequestReviewFollowUpSchema,
  githubPullRequestReviewOpenSchema,
  githubPullRequestReviewSyncSchema,
  githubPrConflictResolveSchema,
  slackAppMentionSchema,
  linearAgentSessionSchema,
  standardTaskSchema,
  suggestedTasksTaskSchema,
  mcpRecommendationsTaskSchema,
  snapshotEnvironmentSchema,
  snapshotResumeSchema,
]);

export type TaskSpec = z.infer<typeof taskSpecSchema>;

/**
 * TaskPayload
 */

export type TaskPayload<T extends TaskPayloadKind = TaskPayloadKind> = Extract<
  TaskSpec,
  { type: T }
>['payload'];

type TaskWorkspacePayload = {
  repo?: string;
  branch?: string;
  sha?: string;
  environmentId?: string;
  selectedRepositories?: string[];
};

export type TaskWorkspace =
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

export function resolveTaskWorkspace(
  payload: TaskWorkspacePayload,
): TaskWorkspace {
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
 * TaskPayload Type Guards
 */

export function isPrReviewTaskRun(
  type: TaskPayloadKind,
  _payload: TaskPayload,
): _payload is
  | TaskPayload<typeof TaskPayloadKind.GithubPrReview>
  | TaskPayload<typeof TaskPayloadKind.GithubPrReviewSync> {
  return (
    type === TaskPayloadKind.GithubPrReview ||
    type === TaskPayloadKind.GithubPrReviewSync
  );
}

/**
 * RunStatus
 */

export enum RunStatus {
  Pending = 'pending', // Run is created, but not yet dequeued by the controller.
  Dequeued = 'dequeued', // Run is dequeued by the controller but not yet started by the worker.
  Processing = 'processing', // Run is dequeued by the worker.
  Preparing = 'preparing', // Worker is preparing the workspace.
  Spawning = 'spawning', // Worker is spawning the VSCode process.
  Connecting = 'connecting', // Worker is connecting to the VSCode process via IPC.
  Running = 'running', // Worker is running the task.
  Completed = 'completed', // Run completed successfully.
  Failed = 'failed', // Run failed.
  Canceled = 'canceled', // Run was canceled manually.
  Idle = 'idle', // Run is technically completed, but the container is still running and waiting for optional interaction.
}

export const bootingRunStatuses = [
  RunStatus.Pending,
  RunStatus.Dequeued,
  RunStatus.Processing,
  RunStatus.Preparing,
  RunStatus.Spawning,
  RunStatus.Connecting,
] as const;

export const activeRunStatuses = [
  ...bootingRunStatuses,
  RunStatus.Running,
  RunStatus.Idle,
] as const;

export const doneRunStatuses = [
  RunStatus.Completed,
  RunStatus.Failed,
  RunStatus.Canceled,
  RunStatus.Idle,
] as const;

export const runningRunStatuses = [RunStatus.Running, RunStatus.Idle] as const;

const runningStatuses = new Set<RunStatus>(runningRunStatuses);

export const exitedRunStatuses = [
  RunStatus.Completed,
  RunStatus.Failed,
  RunStatus.Canceled,
] as const;

const exitedStatuses = new Set<RunStatus>(exitedRunStatuses);

export const isBootingRunStatus = (status?: RunStatus): boolean =>
  !!status && !runningStatuses.has(status) && !exitedStatuses.has(status);

export const isRunningRunStatus = (status?: RunStatus): boolean =>
  !!status && runningStatuses.has(status);

export const isExitedRunStatus = (status?: RunStatus): boolean =>
  !!status && exitedStatuses.has(status);

/**
 * Lifecycle of environment setup (repository setup commands and Docker
 * projects) for a task run. Distinct from `setupCompletedAt`: that milestone
 * stamps when the blocking portion of setup returned, while environment setup
 * may keep running in the background after the agent has already started.
 *
 * - running: Background environment setup is still executing.
 * - completed: All environment setup finished without warnings.
 * - completed_with_warnings: Finished, but one or more steps reported warnings.
 * - failed: Environment setup aborted with an unexpected error.
 */
export const environmentSetupStates = [
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
] as const;

export type EnvironmentSetupState = (typeof environmentSetupStates)[number];

/**
 * Task phases reported by the worker's HarnessManager, plus control-plane
 * phases used before a worker can start.
 *
 * - idle: No task is running yet (initial state).
 * - waiting_for_sandbox_provider: The task is persisted but compute is not ready.
 * - running: Agent is actively working.
 * - waiting_for_prompt: Task completed, waiting for user follow-up.
 * - waiting_for_user_input: Agent is waiting for user input.
 * - stopped: Task was stopped by user.
 * - shutting_down: Keepalive expired, container shutting down.
 */
export type TaskPhase =
  | 'idle'
  | 'waiting_for_sandbox_provider'
  | 'waiting_for_prompt'
  | 'waiting_for_user_input'
  | 'running'
  | 'stopped'
  | 'shutting_down';

export const TASK_PHASES: readonly TaskPhase[] = [
  'idle',
  'waiting_for_sandbox_provider',
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
 * Returns true when the task is actively consuming attention -- either
 * still booting or the agent is actively working.  Use this to drive loading
 * indicators and "running" badge counts instead of relying solely on
 * RunStatus.
 *
 * The `taskPhase` column is populated by the worker once the run reaches
 * the Running status.  For older runs that never set a phase we fall back
 * to the legacy behaviour (treat Running status as active).
 */
export function isActivelyRunningTask(
  status?: RunStatus | null,
  taskPhase?: string | null,
): boolean {
  if (!status) {
    return false;
  }

  // Exited runs are never active.
  if (exitedStatuses.has(status)) {
    return false;
  }

  // Booting runs (Pending → Connecting) are always active.
  if (isBootingRunStatus(status)) {
    return true;
  }

  // Idle status means the run completed (container still alive for keepalive).
  if (status === RunStatus.Idle) {
    return false;
  }

  // Running status: check the task phase.
  if (status === RunStatus.Running) {
    // No phase info yet (still initialising or legacy run) → treat as active.
    if (!taskPhase) {
      return true;
    }

    return WORKING_TASK_PHASES.has(taskPhase as TaskPhase);
  }

  return false;
}

/**
 * Returns true when the task is busy executing a turn, or booting
 * toward one.
 *
 * Unlike {@link isActivelyRunningTask}, which drives UI "running" badge
 * counts and short-circuits on the Idle status, this treats the
 * worker-reported task phase as the source of truth for live sandboxes: a
 * task run row only holds the Running status during its first turn, flips to
 * Idle when that turn completes, and then stays Idle for every follow-up turn
 * on the still-alive sandbox while `taskPhase` toggles between `running` and
 * `waiting_for_prompt`. Use this check when deciding whether it is safe to
 * deliver conversation messages that should only arrive while the task is not
 * mid-turn.
 */
export function isTaskExecutingTurn(
  status?: RunStatus | null,
  taskPhase?: string | null,
): boolean {
  if (!status) {
    return false;
  }

  // Exited runs are never mid-turn (terminal transitions also null the phase).
  if (exitedStatuses.has(status)) {
    return false;
  }

  // Booting runs (Pending → Connecting) are about to execute a turn.
  if (isBootingRunStatus(status)) {
    return true;
  }

  // Running with no phase info yet (still initialising or legacy run) →
  // treat as mid-turn.
  if (status === RunStatus.Running && !taskPhase) {
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
