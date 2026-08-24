import {
  type CommunicationProvider,
  type AcpRequestUserInputAnswers,
  buildInferenceGatewayUrl,
  DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
  INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME,
  INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME,
  INFERENCE_GATEWAY_XAI_ENV_VAR_NAME,
  INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME,
  INFERENCE_GATEWAY_URL_ENV_VAR_NAME,
  isTaskModelIdDisabled,
  OPENCODE_AUTH_CONTENT_ENV_VAR_NAME,
  parseInferenceGatewayKeys,
  RunStatus,
  TaskPayloadKind,
  type QueuedCommunicationMessage,
  getSlackChannelFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
  isCommunicationProvider,
  SANDBOX_SERVER_PORT,
  SANDBOX_TIMEOUT_MS,
} from '@roomote/types';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import packageJson from '../../../../package.json';

import { validateToken } from '@roomote/auth/client';
import {
  buildRoomoteSystemPrompt,
  resolveRoomoteReleaseVersion,
  stripLeadingSlackProductMention,
  wrapSlackMessage,
} from '@roomote/cloud-agents';
import { sdk } from '@roomote/sdk/client';
import {
  prependLinearMessages,
  type LinearSessionMessage,
} from '@roomote/linear/client';
import { prependSlackMessages } from '@roomote/slack/client';
import { prependCommunicationMessages } from '@roomote/communication/messages';

import {
  HarnessManager,
  createInitialTaskState,
  createServer,
} from '../sandbox-server';
import { recordChatTurnStart } from '../mcp/roomote-mcp-server/chat-reply-satisfaction';
import { recordSandboxPromptSlackTurnStart } from '../sandbox-server/procedures/slackReplyTurnTracking';
import { type IntegrationMcpOptions } from '../commands/setup/setup-mcps';

import type {
  EnvironmentSetupSettledOutcome,
  RunTaskOptions,
  RunTaskState,
} from './types';
import {
  DEFAULT_DELEGATED_KEEPALIVE_MS,
  DEFAULT_KEEPALIVE_DEV_MS,
  DEFAULT_KEEPALIVE_MS,
} from './constants';
import { buildOpenCodeHarnessEnv, sanitizeEnv } from './env';
import { startPolling, stopPolling } from './polling';
import { getLinearSessionIdFromResumePayload } from './linear-resume-payload';
import { awaitSubprocess } from './subprocess';
import { resolveStatus } from './resolve-status';
import { getDefaultKeepaliveMs } from './completion';
import { waitForExternalSleepAction } from './wait-for-external-sleep-action';
import { scrubSandboxSecretsBeforeSnapshot } from '../commands/utils/scrub-sandbox-secrets';
import {
  buildWorkerRuntimeStateDetails,
  buildWorkerTaskEventDetails,
  createWorkerRuntimeEventRecorder,
} from './task-run-events';
import { TaskCancellationController } from './task-cancellation-controller';
import {
  activateSkillsFolder,
  resolvePackagedSkillsFolder,
  seedRuntimeHomeMiseGlobalConfig,
} from './agent-home';
import { installZeroCli } from '../commands/setup/agent-clis';

import { createHarness } from './create-harness';
import { createActorScopedMcpRefresher } from './actor-scoped-mcp-refresh';
import { createActorMismatchSkipNotifier } from './actor-mismatch-notice';
import { buildSandboxInstruction } from './sandbox-instruction';
import {
  buildMcpTaskEnv,
  getCommunicationReplyContext,
  getSlackReplyContext,
  isFastAgentChildTaskRun,
} from './mcp-task-env';
import {
  type ActorMismatchPolicy,
  prepareActorScopedTurn as prepareActorScopedTurnHelper,
  syncActorScopedTurnState,
} from './prepare-actor-scoped-turn';
import {
  getRepoLocalSkillInvocations,
  type RepoLocalSkill,
} from '../workspace/repo-local-skills';
import { resolveWorkerCodingHarness } from '../lib/resolve-worker-coding-harness';
import { writeSharedWorkspaceAgentsFile } from './shared-workspace-agents';
import {
  getFollowUpWorkflowPhase,
  getInitialWorkflowPhase,
} from './workflow-phase';
import { wrapCommunicationMessage } from './communication-message-prompt';
import { buildTaskGoalContinuationPrompt } from './task-goal';
import { settleMissingChatCloseoutFallback } from './missing-chat-closeout-fallback-settlement';
import { isMissingSlackReplyTargetProcedureError } from './slack-reply-target';

function formatEnvironmentInstructions(
  instructions?: string,
): string | undefined {
  if (!instructions) {
    return undefined;
  }

  return `<environment-instructions>\n${instructions}\n</environment-instructions>`;
}

function normalizeInstructionText(instructions?: string): string | undefined {
  const trimmed = instructions?.trim();

  return trimmed ? trimmed : undefined;
}

function resolveTaskRuntimeHomeDir(workspacePath: string): string {
  return join(workspacePath, '.roomote-runtime-home');
}

function formatWorkspaceReadinessWarnings(
  warnings?: string[],
): string | undefined {
  const normalizedWarnings =
    warnings?.map((warning) => warning.trim()).filter(Boolean) ?? [];

  if (normalizedWarnings.length === 0) {
    return undefined;
  }

  return [
    'Workspace readiness notice:',
    'This task is starting before workspace readiness is fully settled. Some environment setup steps may still be running or may have reported warnings.',
    'Acknowledge this politely if it affects the user request, and do not assume the environment is fully configured.',
    ...normalizedWarnings.map((warning) => `- ${warning}`),
  ].join('\n');
}

/**
 * In-session notification delivered when background environment setup
 * settles while the agent is already working. The trailing guard sentence is
 * insurance against the #661 duplicate-question bug for the narrow race where
 * a request_user_input is issued between the delivery-time phase check and
 * the prompt landing in the session.
 */
function buildEnvironmentSetupSettledPrompt(
  outcome: EnvironmentSetupSettledOutcome,
): string {
  const doNotRepeatQuestions =
    'If you have already asked the user a question that is still unanswered, do not repeat or re-issue it — keep waiting for their reply.';

  if (outcome.status === 'rejected') {
    return [
      ...buildEnvironmentSetupSettledOutcomeSummary(outcome),
      'Check `.roomote/setup-status.json` and `.roomote/setup-logs/` in the workspace root before relying on installed dependencies or running services. Continue with the user request and mention the failure if it affects your work.',
      doNotRepeatQuestions,
    ].join('\n');
  }

  if (outcome.warningMessages.length > 0) {
    return [
      ...buildEnvironmentSetupSettledOutcomeSummary(outcome),
      'Details are in `.roomote/setup-status.json` and `.roomote/setup-logs/` in the workspace root. Verify anything you depend on is actually available. Continue with the user request; only mention this if it affects your work.',
      doNotRepeatQuestions,
    ].join('\n');
  }

  return [
    ...buildEnvironmentSetupSettledOutcomeSummary(outcome),
    'The environment is now fully configured; `.roomote/setup-status.json` has per-command results. Continue with the user request — no action or acknowledgement is needed.',
    doNotRepeatQuestions,
  ].join('\n');
}

function buildEnvironmentSetupSettledOutcomeSummary(
  outcome: EnvironmentSetupSettledOutcome,
): string[] {
  if (outcome.status === 'rejected') {
    return [
      'Environment setup update: background environment setup failed unexpectedly.',
      `Error: ${outcome.errorMessage}`,
    ];
  }

  if (outcome.warningMessages.length > 0) {
    return [
      'Environment setup update: background environment setup (repository setup commands and Docker projects) finished with warnings:',
      ...outcome.warningMessages.map((warning) => `- ${warning}`),
    ];
  }

  return [
    'Environment setup update: background environment setup (repository setup commands and Docker projects) finished successfully.',
  ];
}

/**
 * Variant of the settled notice used to wake a task that went idle while
 * background setup was still running, so a task that reported itself blocked
 * on setup can resume without a manual user nudge. The zero-tool-call escape
 * hatch is load-bearing: after a terminal closeout, any non-Slack tool call
 * re-arms the Slack stop hook's closeout requirement
 * (current_turn_terminal_reply_stale), so an agent that "just checks"
 * something before ending an already-completed task would be forced to post
 * a redundant message.
 */
function buildEnvironmentSetupSettledWakePrompt(
  outcome: EnvironmentSetupSettledOutcome,
): string {
  return [
    ...buildEnvironmentSetupSettledOutcomeSummary(outcome),
    'Per-command results are in `.roomote/setup-status.json` in the workspace root, with output logs under `.roomote/setup-logs/`.',
    'Your previous turn ended while this environment setup was still running.',
    "If any part of the user's request was deferred or reported as blocked because setup had not finished, continue that work now and report the outcome as you normally would.",
    'If the request was already fully handled, end this turn immediately without calling any tools and without posting any message — this update needs no acknowledgement.',
  ].join('\n');
}

function getInitialSlackTurnMessageTs(taskRun: {
  payloadKind: string;
  payload: unknown;
}): string | null {
  if (!taskRun.payload || typeof taskRun.payload !== 'object') {
    return null;
  }

  const payload = taskRun.payload as {
    slackOriginMessageTs?: unknown;
    thread_ts?: unknown;
    ts?: unknown;
    communicationProvider?: unknown;
    communicationMessageId?: unknown;
  };

  // Non-Slack communication tasks track the launch message so turn-satisfaction
  // machinery (ack/closeout enforcement, current-turn reactions) applies.
  if (
    (payload.communicationProvider === 'telegram' ||
      payload.communicationProvider === 'teams' ||
      payload.communicationProvider === 'discord') &&
    typeof payload.communicationMessageId === 'string' &&
    payload.communicationMessageId.trim()
  ) {
    return payload.communicationMessageId.trim();
  }

  if (
    taskRun.payloadKind !== TaskPayloadKind.SlackAppMention &&
    taskRun.payloadKind !== TaskPayloadKind.SnapshotResume
  ) {
    return null;
  }

  for (const value of [
    payload.slackOriginMessageTs,
    payload.ts,
    payload.thread_ts,
  ]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function isCommunicationLaunchPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const provider = (payload as { communicationProvider?: unknown })
    .communicationProvider;

  return (
    provider === 'telegram' || provider === 'teams' || provider === 'discord'
  );
}

function shouldAllowEmojiReactionOnInitialTurn(taskRun: {
  payloadKind: string;
  payload: unknown;
}): boolean {
  // Chat-launched tasks must answer their first turn with a real reply, not
  // just an emoji reaction.
  if (taskRun.payloadKind === TaskPayloadKind.SlackAppMention) {
    return false;
  }

  return !isCommunicationLaunchPayload(taskRun.payload);
}

function hasAutomationWorkItemId(taskRun: { payload: unknown }): boolean {
  if (!taskRun.payload || typeof taskRun.payload !== 'object') {
    return false;
  }

  const payload = taskRun.payload as {
    automationWorkItemId?: unknown;
  };

  return (
    typeof payload.automationWorkItemId === 'string' &&
    payload.automationWorkItemId.trim().length > 0
  );
}

function hasCustomAutomationId(taskRun: { payload: unknown }): boolean {
  if (!taskRun.payload || typeof taskRun.payload !== 'object') {
    return false;
  }

  const payload = taskRun.payload as {
    customAutomationId?: unknown;
  };

  return (
    typeof payload.customAutomationId === 'string' &&
    payload.customAutomationId.trim().length > 0
  );
}

function hasScheduledAutomationSource(taskRun: { payload: unknown }): boolean {
  if (!taskRun.payload || typeof taskRun.payload !== 'object') {
    return false;
  }

  const payload = taskRun.payload as {
    suggestionSource?: unknown;
  };

  return (
    typeof payload.suggestionSource === 'string' &&
    payload.suggestionSource.trim().length > 0
  );
}

/**
 * Channel-only automation launches stay silent until they have a result or
 * blocker. Scheduled scan tasks have no inbound message to acknowledge, and
 * execution tasks late-bind their report thread on the first chat message.
 */
function isSilentChannelAutomationLaunch(taskRun: {
  payload: unknown;
}): boolean {
  return (
    hasAutomationWorkItemId(taskRun) ||
    hasCustomAutomationId(taskRun) ||
    hasScheduledAutomationSource(taskRun)
  );
}

function shouldRequireInitialAckOnInitialTurn(taskRun: {
  payloadKind: string;
  payload: unknown;
}): boolean {
  // Channel-only automation launches deliberately skip opening
  // acknowledgements.
  if (isSilentChannelAutomationLaunch(taskRun)) {
    return false;
  }

  // Slack launches already post a free-form/template kickoff into the
  // originating thread before the worker runs. Forcing another opening reply
  // only duplicates that message.
  if (taskRun.payloadKind === TaskPayloadKind.SlackAppMention) {
    return false;
  }

  return true;
}

function unwrapRequestTag(prompt: string): string | undefined {
  const trimmed = prompt.trim();

  if (!trimmed.startsWith('<request>') || !trimmed.endsWith('</request>')) {
    return undefined;
  }

  return trimmed
    .slice('<request>'.length, trimmed.length - '</request>'.length)
    .trim();
}

function promoteExplicitRepoLocalSkillInvocation({
  prompt,
  repoLocalSkills,
}: {
  prompt: string;
  repoLocalSkills?: RepoLocalSkill[];
}): string {
  if (!repoLocalSkills?.length) {
    return prompt;
  }

  const requestBody = unwrapRequestTag(prompt);

  if (!requestBody) {
    return prompt;
  }

  const [commandLineRaw, ...remainingLines] = requestBody.split('\n');
  const commandLine = commandLineRaw?.trim() ?? '';

  const repoLocalSkillNames = new Set(
    getRepoLocalSkillInvocations(repoLocalSkills).map(
      (skill) => skill.invocationName,
    ),
  );
  const prefixedSkillMatch = commandLine.match(/^[$/]([A-Za-z0-9._-]+)$/u);
  const plainSkillMatch = commandLine.match(/^([A-Za-z0-9._-]+)$/u);
  const explicitInvocation =
    prefixedSkillMatch?.[1] && repoLocalSkillNames.has(prefixedSkillMatch[1])
      ? commandLine
      : plainSkillMatch?.[1] && repoLocalSkillNames.has(plainSkillMatch[1])
        ? commandLine
        : undefined;

  if (!explicitInvocation) {
    return prompt;
  }

  const remainingBody = remainingLines.join('\n').trim();

  if (remainingBody.length === 0) {
    return explicitInvocation;
  }

  return `${explicitInvocation}\n<request>\n${remainingBody}\n</request>`;
}
function combineAgentInstructions({
  orgAgentInstructions,
  environmentAgentInstructions,
  workspaceReadinessWarnings,
  sandboxInstruction,
}: {
  orgAgentInstructions?: string;
  environmentAgentInstructions?: string;
  workspaceReadinessWarnings?: string[];
  sandboxInstruction?: string;
}): string | undefined {
  const normalizedOrgInstructions =
    normalizeInstructionText(orgAgentInstructions);
  const normalizedEnvironmentInstructions = normalizeInstructionText(
    environmentAgentInstructions,
  );
  const normalizedWorkspaceReadinessWarnings = normalizeInstructionText(
    formatWorkspaceReadinessWarnings(workspaceReadinessWarnings),
  );
  const normalizedSandboxInstruction =
    normalizeInstructionText(sandboxInstruction);

  let combinedInstructions: string | undefined;

  if (normalizedOrgInstructions && normalizedEnvironmentInstructions) {
    combinedInstructions = [
      'Organization-wide agent behavior:',
      normalizedOrgInstructions,
      '',
      'Environment-specific agent instructions:',
      normalizedEnvironmentInstructions,
    ].join('\n');
  } else {
    combinedInstructions =
      normalizedEnvironmentInstructions ?? normalizedOrgInstructions;
  }

  if (normalizedWorkspaceReadinessWarnings) {
    combinedInstructions = combinedInstructions
      ? `${combinedInstructions}\n\n${normalizedWorkspaceReadinessWarnings}`
      : normalizedWorkspaceReadinessWarnings;
  }

  if (normalizedSandboxInstruction) {
    combinedInstructions = combinedInstructions
      ? `${combinedInstructions}\n${normalizedSandboxInstruction}`
      : normalizedSandboxInstruction;
  }

  return combinedInstructions;
}

/**
 * Crash-persistence context for the currently running task. The
 * `uncaughtException`/`unhandledRejection` listeners are registered at most
 * once per process (see {@link ensureWorkerCrashHandlersRegistered}) and read
 * this mutable slot at crash time, so per-run handler registration can never
 * leak listeners across `executeTaskRun` retries: each `runTask` overwrites the
 * context on entry and clears it on its controlled exits.
 */
interface WorkerCrashContext {
  runId: number;
  logger: { error: (message: string) => void };
  /** Reads the latest task run result so unrelated fields are preserved. */
  getResult: () => unknown;
}

let activeWorkerCrashContext: WorkerCrashContext | null = null;
let workerCrashHandlersRegistered = false;

/**
 * Persist fatal process errors to the task run result before dying. The
 * worker runs in a remote sandbox whose stdout is unreachable post-mortem;
 * an intermittent turn-end crash was only diagnosable through heartbeat
 * archaeology. Best-effort persist, then preserve crash semantics by
 * exiting non-zero (with a hard exit timer in case the persist hangs).
 * Without an active context (crash outside a run) there is nothing to
 * attribute the crash to: log and exit without a DB write.
 */
function handleWorkerCrash(kind: string, reason: unknown): void {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  const context = activeWorkerCrashContext;

  if (!context) {
    console.error(
      `[runTask] FATAL ${kind} outside an active task run: ${error.stack ?? error.message}`,
    );
    process.exit(1);
    return;
  }

  context.logger.error(
    `[runTask] FATAL ${kind}: ${error.stack ?? error.message}`,
  );
  setTimeout(() => process.exit(1), 5_000).unref();

  const result = context.getResult();
  const existingResult =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};

  void sdk.taskRuns
    .update({
      id: context.runId,
      result: {
        ...existingResult,
        workerCrash: {
          kind,
          message: error.message,
          stack: error.stack?.slice(0, 4_000),
          atMs: Date.now(),
        },
      },
    })
    .catch(() => {})
    .finally(() => process.exit(1));
}

/**
 * Register the process-level crash listeners exactly once per process. The
 * listeners themselves are permanent; per-run state lives entirely in
 * {@link activeWorkerCrashContext}, so repeated `runTask` invocations (e.g.
 * `executeTaskRun` retries) never accumulate listeners.
 */
function ensureWorkerCrashHandlersRegistered(): void {
  if (workerCrashHandlersRegistered) {
    return;
  }

  workerCrashHandlersRegistered = true;
  process.on('uncaughtException', (error) =>
    handleWorkerCrash('uncaughtException', error),
  );
  process.on('unhandledRejection', (reason) =>
    handleWorkerCrash('unhandledRejection', reason),
  );
}

const DEFERRED_RESUME_PROMPT_RETRY_MS = 5_000;

type QueuedSnapshotResumeSlackMessage = {
  text: string;
  user: string;
  userId?: string;
  ts: string;
  images?: string[];
  formattedPrompt?: string;
  turnPolicy?: {
    reactionsAllowed?: boolean;
  };
};

type QueuedSnapshotResumeCommunicationMessage = QueuedCommunicationMessage & {
  provider: CommunicationProvider;
};

function getQueuedSnapshotResumeCommunicationMessages(
  payload: Record<string, unknown> | null,
): QueuedSnapshotResumeCommunicationMessage[] {
  return Array.isArray(payload?.queuedCommunicationMessages)
    ? (payload.queuedCommunicationMessages.filter(
        (message): message is QueuedSnapshotResumeCommunicationMessage =>
          Boolean(message) &&
          typeof message === 'object' &&
          isCommunicationProvider(
            (message as QueuedSnapshotResumeCommunicationMessage).provider,
          ) &&
          typeof (message as QueuedSnapshotResumeCommunicationMessage).text ===
            'string' &&
          typeof (message as QueuedSnapshotResumeCommunicationMessage).user ===
            'string' &&
          typeof (message as QueuedSnapshotResumeCommunicationMessage).ts ===
            'string',
      ) as QueuedSnapshotResumeCommunicationMessage[])
    : [];
}

function getQueuedSnapshotResumeSlackMessages(
  payload: Record<string, unknown> | null,
): QueuedSnapshotResumeSlackMessage[] {
  return Array.isArray(payload?.queuedSlackMessages)
    ? (payload.queuedSlackMessages.filter(
        (message): message is QueuedSnapshotResumeSlackMessage =>
          Boolean(message) &&
          typeof message === 'object' &&
          typeof (message as QueuedSnapshotResumeSlackMessage).text ===
            'string' &&
          typeof (message as QueuedSnapshotResumeSlackMessage).user ===
            'string' &&
          typeof (message as QueuedSnapshotResumeSlackMessage).ts === 'string',
      ) as QueuedSnapshotResumeSlackMessage[])
    : [];
}

function getQueuedSnapshotResumeLinearMessages(
  payload: Record<string, unknown> | null,
): LinearSessionMessage[] {
  return Array.isArray(payload?.queuedLinearMessages)
    ? (payload.queuedLinearMessages.filter(
        (message): message is LinearSessionMessage =>
          Boolean(message) &&
          typeof message === 'object' &&
          typeof (message as LinearSessionMessage).sessionId === 'string' &&
          typeof (message as LinearSessionMessage).organizationId ===
            'string' &&
          typeof (message as LinearSessionMessage).payload === 'object',
      ) as LinearSessionMessage[])
    : [];
}

export const runTask = async ({
  taskRun,
  envVars,
  userEnvVars,
  workspacePath,
  usesSharedWorkspaceRoot,
  repoPaths,
  repoLocalSkills,
  workspaceReadinessWarnings,
  backgroundEnvironmentSetup,
  prompt,
  harnessInstructions,
  requestedWorkKind,
  task,
  orgAgentInstructions,
  agentInstructions,
  environmentConfig,
  callbacks,
  context,
  logger,
  cancelSignal: externalCancelSignal,
  harnessSessionId,
  workerEnv,
  skipExternalSleepAction = false,
  keepaliveMsOverride,
}: RunTaskOptions) => {
  await sdk.taskRuns.update({
    id: taskRun.id,
    status: RunStatus.Spawning,
  });
  await callbacks.onStatus?.(taskRun, RunStatus.Spawning, context);

  // Register the process-level crash listeners (at most once per process) and
  // point them at this run via the module-level context slot. The `finally` at
  // the end of `runTask` clears the context unconditionally, so the listeners
  // can never attribute a later crash to a stale task run even if `runTask`
  // throws between here and a controlled exit — no per-run listeners are
  // installed, so nothing leaks across `executeTaskRun` retries.
  ensureWorkerCrashHandlersRegistered();
  activeWorkerCrashContext = {
    runId: taskRun.id,
    logger,
    getResult: () => taskRun.result,
  };

  try {
    const harnessType = resolveWorkerCodingHarness(taskRun.harness);

    // Polling interval state — kept in the worker since it depends on SDK.
    const pollingState: RunTaskState = {
      ...createInitialTaskState(),
      cancelInterval: undefined,
      slackMessageInterval: undefined,
      slackMessageCleanup: undefined,
      communicationMessageIntervals: undefined,
      communicationMessageCleanups: undefined,
      linearMessageInterval: undefined,
      githubTokenRefreshInterval: undefined,
    };

    const unsanitizedEnv = workerEnv
      ? {
          ...workerEnv.buildUserFacingEnv(),
          ...(workerEnv.buildOpenCodeHarnessEnv?.() ?? {}),
          ...envVars,
        }
      : { ...process.env, ...envVars };

    const sanitizedEnv = sanitizeEnv(unsanitizedEnv);
    const openCodeHarnessEnv = buildOpenCodeHarnessEnv(unsanitizedEnv);

    // Org env vars (from the dequeue payload) are merged BEFORE sanitizeEnv
    // so that system-critical vars (HOME, PATH, GH_TOKEN, etc.) from the
    // sanitized allowlist always take precedence. This prevents an org from
    // accidentally (or maliciously) overriding vars the worker relies on.
    const deploymentEnvVars: Record<string, string> = Object.fromEntries(
      Object.entries(envVars).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

    const runtimeEnv: Record<string, string> = {
      ...deploymentEnvVars,
      ...sanitizedEnv,
      ...openCodeHarnessEnv,
      R_APP_URL: workerEnv.roomoteAppUrl,
      ROOMOTE_PLATFORM_API_URL: workerEnv.trpcUrl,
      ROOMOTE_WORKSPACE_PATH: workspacePath,
      ROOMOTE_CLOUD_TOKEN: workerEnv.authToken,
      ROOMOTE_TASK_ID: taskRun.taskId,
      ROOMOTE_TASK_RUN_ID: String(taskRun.id),
      AGENT_BROWSER_SESSION: taskRun.taskId,
      ROOMOTE_TASK_TYPE: taskRun.payloadKind,
      ROOMOTE_AUTOMATION_TASK:
        taskRun.payloadKind === TaskPayloadKind.Scan ||
        isSilentChannelAutomationLaunch(taskRun)
          ? 'true'
          : 'false',
      ...(unsanitizedEnv.ROOMOTE_AUTH_BYPASS_VALUE && {
        ROOMOTE_AUTH_BYPASS_VALUE: unsanitizedEnv.ROOMOTE_AUTH_BYPASS_VALUE,
      }),
      ...(unsanitizedEnv.ROOMOTE_AUTH_BYPASS_HEADER_NAME && {
        ROOMOTE_AUTH_BYPASS_HEADER_NAME:
          unsanitizedEnv.ROOMOTE_AUTH_BYPASS_HEADER_NAME,
      }),
      // Consumed (and removed) by generateOpenCodeConfig, which registers the
      // hidden proof-runner subagent only when a browser surface exists.
      ...(environmentConfig?.initialUrl && {
        ROOMOTE_PROOF_BROWSER_TARGET: environmentConfig.initialUrl,
      }),
    };
    // Strip credentials for disabled providers as defense in depth, even if a
    // stale worker/dequeue payload still contains them.
    for (const envVarName of DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES) {
      delete runtimeEnv[envVarName];
    }
    for (const modelEnvVarName of [
      'R_MODEL',
      'R_SMALL_MODEL',
      'R_VISION_MODEL',
      'R_CODE_REVIEW_MODEL',
      'R_EXPLORE_MODEL',
      'R_PLANNING_MODEL',
    ] as const) {
      const modelId = runtimeEnv[modelEnvVarName];

      if (modelId && isTaskModelIdDisabled(modelId)) {
        delete runtimeEnv[modelEnvVarName];
      }
    }

    // Inference gateway: dequeue advertises the served provider keys by name
    // (R_INFERENCE_GATEWAY_KEYS) rather than the gateway URL, so the URL is
    // built here from the worker's own platform URL — already rewritten to be
    // container-reachable per compute provider (Docker host.docker.internal,
    // etc.). The served keys are stripped from the harness env even though
    // dequeue withheld them, because buildOpenCodeHarnessEnv re-adds provider
    // keys from the worker daemon's process env (present on sandboxes spawned
    // before the flag was enabled); this keeps the withheld set out of the
    // harness env and env.sh regardless of daemon state.
    const inferenceGatewayServedKeys = parseInferenceGatewayKeys(
      unsanitizedEnv[INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME],
    );
    // A connected ChatGPT subscription served through the gateway carries no
    // env key; dequeue signals it with a marker instead and omits the OAuth
    // record, which the gateway holds and injects server-side.
    const inferenceGatewayChatGpt =
      unsanitizedEnv[INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME] === '1';
    const inferenceGatewayGitHubCopilot =
      unsanitizedEnv[INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME] === '1';
    const inferenceGatewayXai =
      unsanitizedEnv[INFERENCE_GATEWAY_XAI_ENV_VAR_NAME] === '1';

    if (
      inferenceGatewayServedKeys.length > 0 ||
      inferenceGatewayChatGpt ||
      inferenceGatewayGitHubCopilot ||
      inferenceGatewayXai
    ) {
      for (const servedKey of inferenceGatewayServedKeys) {
        delete runtimeEnv[servedKey];
      }

      runtimeEnv[INFERENCE_GATEWAY_URL_ENV_VAR_NAME] = buildInferenceGatewayUrl(
        workerEnv.trpcUrl,
      );

      if (inferenceGatewayServedKeys.length > 0) {
        runtimeEnv[INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME] =
          inferenceGatewayServedKeys.join(',');
      } else {
        delete runtimeEnv[INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME];
      }

      if (inferenceGatewayChatGpt) {
        runtimeEnv[INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME] = '1';
        // Gateway mode holds the OAuth record; it must never reach the sandbox.
        delete runtimeEnv[OPENCODE_AUTH_CONTENT_ENV_VAR_NAME];
      } else {
        delete runtimeEnv[INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME];
      }
      if (inferenceGatewayGitHubCopilot) {
        runtimeEnv[INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME] = '1';
        delete runtimeEnv[OPENCODE_AUTH_CONTENT_ENV_VAR_NAME];
      } else {
        delete runtimeEnv[INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME];
      }
      if (inferenceGatewayXai) {
        runtimeEnv[INFERENCE_GATEWAY_XAI_ENV_VAR_NAME] = '1';
        delete runtimeEnv[OPENCODE_AUTH_CONTENT_ENV_VAR_NAME];
      } else {
        delete runtimeEnv[INFERENCE_GATEWAY_XAI_ENV_VAR_NAME];
      }
    } else {
      delete runtimeEnv[INFERENCE_GATEWAY_KEYS_ENV_VAR_NAME];
      delete runtimeEnv[INFERENCE_GATEWAY_URL_ENV_VAR_NAME];
      delete runtimeEnv[INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME];
      delete runtimeEnv[INFERENCE_GATEWAY_GITHUB_COPILOT_ENV_VAR_NAME];
      delete runtimeEnv[INFERENCE_GATEWAY_XAI_ENV_VAR_NAME];
    }

    const workerHomeDir = runtimeEnv.HOME ?? sanitizedEnv.HOME ?? '';

    if (workerHomeDir) {
      runtimeEnv.HOME = resolveTaskRuntimeHomeDir(workspacePath);

      if (
        seedRuntimeHomeMiseGlobalConfig({
          homeDir: runtimeEnv.HOME,
          sourceHomeDir: workerHomeDir,
        })
      ) {
        logger.info(
          `[runTask] Seeded runtime home mise global config from ${workerHomeDir}`,
        );
      }
    }

    delete runtimeEnv.ROOMOTE_TASK_TERMINAL;
    delete runtimeEnv.ROOMOTE_SLACK_CHANNEL;
    delete runtimeEnv.ROOMOTE_SLACK_THREAD_TS;
    delete runtimeEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE;
    runtimeEnv.ROOMOTE_TASK_TERMINAL = 'true';

    const selectedSkillsFolder = resolvePackagedSkillsFolder({
      configuredSkillsFolder: undefined,
    });

    const initialPrompt = promoteExplicitRepoLocalSkillInvocation({
      prompt: prompt ?? '',
      repoLocalSkills,
    });
    const initialWorkflowPhase = getInitialWorkflowPhase({
      prompt: initialPrompt,
      requestedWorkKind: requestedWorkKind ?? null,
    });
    const hasInitialPrompt = initialPrompt.trim().length > 0;
    const images =
      'images' in taskRun.payload && taskRun.payload.images
        ? taskRun.payload.images
        : undefined;
    const hasInitialImages = Boolean(images?.length);

    const homeDir = runtimeEnv.HOME ?? sanitizedEnv.HOME ?? '';

    // Admin opt-in for Zero: only install the CLI / activate the skill when
    // Settings > Integrations has Zero enabled for the deployment.
    let zeroIntegrationEnabled = false;

    try {
      zeroIntegrationEnabled = await sdk.mcpConnections.isOrgEnabled('zero');
    } catch (error) {
      logger.warn(
        `[runTask] Failed to check Zero integration enablement: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (zeroIntegrationEnabled) {
      try {
        await installZeroCli(logger);
      } catch (error) {
        logger.warn(
          `[runTask] Failed to install Zero CLI: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const skillsActivated = activateSkillsFolder({
      homeDir,
      sourceHomeDir: workerHomeDir,
      skillsFolderName: selectedSkillsFolder,
      manualSkills: environmentConfig?.manualSkills,
      repoLocalSkills,
      excludeSkillNames: zeroIntegrationEnabled ? undefined : ['zero'],
    });

    if (skillsActivated) {
      logger.info(
        `[runTask] Activated '${selectedSkillsFolder}' skills folder into .agents/skills`,
      );
    }

    // Fetch integration MCP availability. This is best-effort: failures are
    // logged but never block task execution.
    const integrations: IntegrationMcpOptions = {};

    try {
      const { servers } = await sdk.mcpConnections.getMcpServerConfigs();

      if (Object.keys(servers).length > 0) {
        integrations.userMcpServers = servers;
      }
    } catch (error) {
      logger.warn(
        `[runTask] Failed to fetch user MCP server configs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Deployment-scoped custom stdio MCP servers. Same best-effort posture:
    // a fetch failure means the task runs without them, never that it blocks.
    let deploymentMcpServers:
      | Record<
          string,
          { command: string; args?: string[]; env?: Record<string, string> }
        >
      | undefined;

    try {
      const { servers } = await sdk.mcpConnections.getCustomStdioMcpServers();

      if (Object.keys(servers).length > 0) {
        deploymentMcpServers = servers;
      }
    } catch (error) {
      logger.warn(
        `[runTask] Failed to fetch custom stdio MCP server configs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const slackReplyContext = getSlackReplyContext(taskRun);
    const communicationReplyContext = getCommunicationReplyContext(taskRun);
    if (isFastAgentChildTaskRun(taskRun)) {
      runtimeEnv.ROOMOTE_FAST_AGENT_CHILD = 'true';
    }
    if (slackReplyContext?.threadTs) {
      runtimeEnv.ROOMOTE_SLACK_CHANNEL = slackReplyContext.channel;
      runtimeEnv.ROOMOTE_SLACK_THREAD_TS = slackReplyContext.threadTs;
    }
    const mcpTaskEnv = buildMcpTaskEnv({
      runtimeEnv,
      unsanitizedEnv,
      slackReplyContext,
      communicationReplyContext,
    });
    if (mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE) {
      runtimeEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE =
        mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE;
      mkdirSync(
        dirname(mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE),
        {
          recursive: true,
        },
      );
      const startedAtMs = Date.now();
      const initialTurnMessageTs = getInitialSlackTurnMessageTs(taskRun);
      writeFileSync(
        mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
        JSON.stringify({
          startedAtMs,
          currentTurnRequiresInitialAck:
            shouldRequireInitialAckOnInitialTurn(taskRun),
          ...(initialTurnMessageTs
            ? {
                currentTurnMessageTs: initialTurnMessageTs,
                currentTurnStartedAtMs: startedAtMs,
                currentTurnReactionsAllowed:
                  shouldAllowEmojiReactionOnInitialTurn(taskRun),
              }
            : {}),
        }),
        'utf8',
      );
    }

    // Build sandbox environment context for the agent.
    // Reads ROOMOTE_*_HOST and ROOMOTE_*_PREVIEW_URL vars from the unsanitized
    // env so the generated environment note always sees the injected preview
    // URLs.
    const sandboxInstruction = buildSandboxInstruction(
      Boolean(environmentConfig?.initialUrl),
      environmentConfig,
      {
        envVars,
        backgroundEnvironmentSetupPending:
          backgroundEnvironmentSetup?.hasPendingBackgroundSetup ?? false,
      },
    );
    const environmentInstructions = formatEnvironmentInstructions(
      combineAgentInstructions({
        orgAgentInstructions,
        environmentAgentInstructions: agentInstructions,
        workspaceReadinessWarnings,
        sandboxInstruction,
      }),
    );
    // OpenCode consumes Roomote's identity, workflow, and runtime guidance
    // through its developer-instructions layer.
    const harnessDeveloperInstructions =
      [
        buildRoomoteSystemPrompt(
          resolveRoomoteReleaseVersion(
            process.env.RELEASE_PRODUCT_VERSION,
            process.env.RELEASE_VERSION,
            packageJson.version,
          ),
        ),
        harnessInstructions,
        environmentInstructions,
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n\n') || undefined;

    writeSharedWorkspaceAgentsFile({
      workspacePath,
      usesSharedWorkspaceRoot,
      repoPaths,
    });

    const taskCancellation = new TaskCancellationController({
      runId: taskRun.id,
      logger,
      externalCancelSignal,
    });
    const cancelSignal = taskCancellation.signal;
    let harnessManager: HarnessManager | undefined = undefined;

    await sdk.taskRuns.update({
      id: taskRun.id,
      status: RunStatus.Connecting,
    });
    await callbacks.onStatus?.(taskRun, RunStatus.Connecting, context);

    const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
      runId: taskRun.id,
      logger,
    });
    const persistRuntimeState = createRuntimeStatePersister(
      taskRun.id,
      recordWorkerRuntimeEvent,
    );
    const requestHarnessReconnect = async (options: {
      reason: string;
      afterCurrentTurn?: boolean;
    }) => await harness.requestReconnect?.(options);
    const refreshActorScopedIntegrations = createActorScopedMcpRefresher({
      taskRun,
      integrations,
      requestReconnect: async (options) =>
        await requestHarnessReconnect?.(options),
      logger,
    });

    // The actor most recently prepared locally (git author synced, MCP
    // mounts refreshed). Server-authoritative `task_runs.actingUserId` is
    // the source of truth; this only tracks what this worker last applied so
    // reconciliation knows when to refresh.
    let lastPreparedActorUserId: string | null = taskRun.actingUserId ?? null;
    let gitAuthorSyncPending = false;
    const getLastKnownActorUserId = () => lastPreparedActorUserId;
    const hasPendingGitAuthorSync = () => gitAuthorSyncPending;
    const onActorSynced = (userId: string | null) => {
      lastPreparedActorUserId = userId;
      gitAuthorSyncPending = false;
    };
    const onGitAuthorSyncFailed = () => {
      gitAuthorSyncPending = true;
    };
    const notifyMismatchSkipped = createActorMismatchSkipNotifier({
      runId: taskRun.id,
      logger,
    });

    const prepareActorScopedTurn = async (
      targetUserId?: string,
      options?: {
        allowMcpReconnect?: boolean;
        deferReconnectUntilTurnBoundary?: boolean;
        onMismatch?: ActorMismatchPolicy;
      },
    ) =>
      await prepareActorScopedTurnHelper({
        runId: taskRun.id,
        targetUserId,
        workingDirectory: workspacePath,
        logPrefix: '[runTask]',
        allowMcpReconnect: options?.allowMcpReconnect,
        deferReconnectUntilTurnBoundary:
          options?.deferReconnectUntilTurnBoundary,
        onMismatch: options?.onMismatch,
        getLastKnownActorUserId,
        hasPendingGitAuthorSync,
        onActorSynced,
        onGitAuthorSyncFailed,
        notifyMismatchSkipped,
        logger,
        refreshActorScopedIntegrations,
      });

    // Set when the task's model settings changed while a restart was unsafe
    // (active turn or pending user-input request). Consumed by the next
    // queued-prompt delivery: the prompt is restored, the harness restarts
    // with a regenerated OpenCode config, and the prompt replays on the new
    // models. User-input answers never consume it — a reconnect there fails
    // the answer delivery instead of replaying it.
    let pendingTaskModelSettingsRestart = false;

    const applyTaskModelSettingsUpdate = async (): Promise<{
      application: 'restarted' | 'deferred' | 'unavailable';
    }> => {
      const freshRun = await sdk.taskRuns.findFirstById(taskRun.id);

      if (freshRun?.payload && typeof freshRun.payload === 'object') {
        // createHarness closed over this taskRun object and re-reads its
        // payload at every harness spawn, so refreshing it here is what a
        // restart (or crash reconnect) applies.
        taskRun.payload = freshRun.payload;
      }

      const phase = harnessManager?.getStatus().phase ?? 'idle';

      if (phase === 'shutting_down' || phase === 'stopped') {
        // Too late to apply live; the persisted payload applies on resume.
        return { application: 'unavailable' };
      }

      if (
        phase === 'running' ||
        phase === 'waiting_for_user_input' ||
        !harness.requestReconnect
      ) {
        pendingTaskModelSettingsRestart = true;
        return { application: 'deferred' };
      }

      await harness.requestReconnect({
        reason: 'Task model settings updated',
      });
      return { application: 'restarted' };
    };

    const prepareQueuedPromptActorScope = async (
      targetUserId?: string,
      delivery?: {
        kind: 'queuedPrompt' | 'userInputAnswer';
        clientMessageId?: string;
      },
    ) => {
      if (
        pendingTaskModelSettingsRestart &&
        delivery?.kind !== 'userInputAnswer'
      ) {
        pendingTaskModelSettingsRestart = false;
        return {
          shouldReconnect: true,
          reason: 'Applying updated task model settings before the next turn',
        };
      }

      const finishQueuedPromptPreparation = async (result: {
        shouldReconnect: boolean;
        reason?: string;
      }) => {
        const clientMessageId = delivery?.clientMessageId;
        if (result.shouldReconnect || delivery?.kind !== 'queuedPrompt') {
          return result;
        }

        try {
          if (!clientMessageId?.startsWith('slack:')) {
            await sdk.taskRuns.clearActiveSlackReplyTarget({
              runId: taskRun.id,
            });
            delete context.slackReplyTarget;
            return result;
          }

          const activeTarget = await sdk.taskRuns.activateSlackReplyTarget({
            runId: taskRun.id,
            messageTs: clientMessageId.slice('slack:'.length),
          });
          if (!activeTarget) {
            delete context.slackReplyTarget;
            logger.warn(
              `[runTask] Slack reply target authorization is missing for ${clientMessageId}; delivering with canonical routing`,
            );
          } else {
            context.slackReplyTarget = activeTarget;
            recordChatTurnStart({
              turnMessageTs: clientMessageId.slice('slack:'.length),
              allowReaction: activeTarget.reactionsAllowed,
              sessionId: pollingState.sessionId,
              stateFilePath:
                mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
            });
          }
          return result;
        } catch (error) {
          // A rolled-back API (the supported N-1 target) predates these
          // procedures entirely, and tRPC reports that as NOT_FOUND. The
          // procedures themselves never answer NOT_FOUND (a missing
          // authorization is a null result), so this is unambiguous version
          // skew. Reply-target routing did not exist on that release either,
          // so canonical routing IS its correct behavior; blocking would
          // instead stall every queued prompt until the snapshot is
          // replaced.
          if (isMissingSlackReplyTargetProcedureError(error)) {
            delete context.slackReplyTarget;
            logger.warn(
              `[runTask] Slack reply target procedures are unavailable on this API (rolled-back release?); delivering with canonical routing`,
            );
            return result;
          }

          return {
            shouldReconnect: false,
            shouldBlockPrompt: true,
            reason: `Slack reply target activation failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      };

      if (!targetUserId) {
        return finishQueuedPromptPreparation({
          shouldReconnect: false,
        });
      }

      const syncResult = await syncActorScopedTurnState({
        runId: taskRun.id,
        targetUserId,
        workingDirectory: workspacePath,
        logPrefix: '[runTask]',
        // Queued prompts were accepted through a trusted surface earlier;
        // if another sender has since taken over the run, this prompt's
        // content must not run under the new actor's credentials. Skip it
        // (with a resend notice) rather than stalling the queue forever.
        onMismatch: 'skip',
        getLastKnownActorUserId,
        hasPendingGitAuthorSync,
        onActorSynced,
        onGitAuthorSyncFailed,
        notifyMismatchSkipped,
        logger,
      });

      if (!syncResult.ok) {
        return {
          shouldReconnect: false,
          shouldBlockPrompt: true,
          reason:
            'actor-scoped turn delivery is blocked until actingUserId can be synchronized',
        };
      }

      if (syncResult.skippedMismatch) {
        return {
          shouldReconnect: false,
          shouldSkipPrompt: true,
          reason:
            'queued prompt sender is not the server-side acting user; the prompt was skipped',
        };
      }

      const refreshResult = await refreshActorScopedIntegrations(
        syncResult.effectiveUserId ?? undefined,
        {
          skipReconnect: true,
        },
      );

      if (refreshResult.didFail) {
        if (!refreshResult.actorChanged) {
          return finishQueuedPromptPreparation({
            shouldReconnect: false,
            reason:
              refreshResult.reason ??
              'actor-scoped MCP refresh failed for the current actor; continuing with existing MCP state',
          });
        }

        return {
          shouldReconnect: false,
          shouldBlockPrompt: true,
          reason:
            refreshResult.reason ??
            'actor-scoped MCP refresh must succeed before the queued prompt can run',
        };
      }

      return finishQueuedPromptPreparation({
        shouldReconnect: refreshResult.didChange,
        reason: refreshResult.reason,
      });
    };

    // Create the appropriate runtime harness. Harness setup wires the
    // callback subscription that handles persistence and callback dispatch.
    const {
      harness,
      getSubprocess,
      unsubscribe: unsubscribeHarness,
    } = await createHarness({
      harnessType,
      workspacePath,
      runtimeEnv,
      harnessSessionId,
      cancelSignal,
      integrations,
      mcpTaskEnv,
      environmentMcpServers: environmentConfig?.mcpServers,
      deploymentMcpServers,
      // The pre-injection snapshot, NOT deploymentEnvVars: by harness start,
      // `envVars` has been mutated with runtime-internal entries (auth bypass
      // values, BASH_ENV, ...) that must not ride the operator overlay past
      // the reserved-name guard.
      operatorEnvVars: Object.fromEntries(
        Object.entries(userEnvVars ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      taskRun,
      developerInstructionsContent: harnessDeveloperInstructions,
      callbacks,
      context,
      logger,
      prepareQueuedPromptActorScope,
    });
    pollingState.isConnected = harness.isConnected;

    const sandboxTimeoutMs =
      Number(process.env.SANDBOX_TIMEOUT_MS) || SANDBOX_TIMEOUT_MS;

    const sandboxExpiresAtMs = Number(process.env.SANDBOX_EXPIRES_AT_MS);

    const defaultKeepaliveMs =
      workerEnv.appEnv === 'development'
        ? DEFAULT_KEEPALIVE_DEV_MS
        : DEFAULT_KEEPALIVE_MS;

    const keepaliveMs =
      keepaliveMsOverride ??
      taskRun.keepaliveMs ??
      getDefaultKeepaliveMs({
        taskType: taskRun.payloadKind,
        appEnv:
          (workerEnv.appEnv as
            | 'development'
            | 'preview'
            | 'production'
            | 'test'
            | undefined) ?? null,
        defaultKeepaliveMs,
        delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
        sandboxTimeoutMs,
      });

    harnessManager = new HarnessManager({
      harness,
      keepaliveMs,
      sandboxTimeoutMs,
      sandboxExpiresAtMs: Number.isFinite(sandboxExpiresAtMs)
        ? sandboxExpiresAtMs
        : undefined,
      runId: taskRun.id,
      taskId: taskRun.taskId,
      logger,
      callbacks: {
        onTaskCompletionSettled: async (completionId: string) => {
          await settleMissingChatCloseoutFallback(context, completionId);
        },
        onBeforeTaskCompletion: async (completionId: string) => {
          if (taskCancellation.signal.aborted) {
            return 'finalize' as const;
          }

          const claim = await sdk.taskRuns.claimGoalContinuation({
            runId: taskRun.id,
            continuationId: completionId,
          });
          if (!claim.updated) {
            if (claim.reason === 'already_claimed') {
              return 'ignore' as const;
            }
            if (!claim.goal) {
              return 'finalize' as const;
            }
            await recordWorkerRuntimeEvent({
              eventType: 'decision',
              message: `Goal continuation stopped for task run #${taskRun.id}.`,
              details: {
                reason: claim.reason,
                goalStatus: claim.goal?.status ?? null,
              },
            });
            return 'finalize' as const;
          }

          const continuationEvent = (sent: boolean) => ({
            eventType: 'decision' as const,
            message: `Goal continuation ${sent ? 'started' : 'could not start'} for task run #${taskRun.id}.`,
            details: {
              reason: 'goal_continuation',
              delivered: sent,
              continuation: claim.goal.continuationsUsed,
              maxContinuations: claim.goal.maxContinuations,
            },
          });
          return {
            disposition: 'continue' as const,
            prompt: {
              prompt: buildTaskGoalContinuationPrompt(claim.goal),
              goalContext: claim.goal,
              visibleInTranscript: false,
              source: 'goal-continuation',
              clientMessageId: `goal-continuation:${completionId}`,
            },
            onAccepted: () => {
              void recordWorkerRuntimeEvent(continuationEvent(true));
            },
            onRejected: async () => {
              await sdk.taskRuns.releaseGoalContinuation({
                runId: taskRun.id,
                continuationId: completionId,
              });
              await recordWorkerRuntimeEvent(continuationEvent(false));
            },
          };
        },
        onStart: async (taskId: string) => {
          try {
            await sdk.taskRuns.setHarnessSessionId({
              runId: taskRun.id,
              harnessSessionId: taskId,
            });
          } catch (error) {
            logger.warn(
              `[runTask] Failed to persist harness session ID for task run ${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          await stampRuntimeTaskStartedAt();

          const existingResult =
            taskRun.result &&
            typeof taskRun.result === 'object' &&
            !Array.isArray(taskRun.result)
              ? (taskRun.result as Record<string, unknown>)
              : {};

          const existingRuntimeTaskId =
            typeof existingResult.runtimeTaskId === 'string'
              ? existingResult.runtimeTaskId
              : null;

          // Keep runtimeTaskId synchronized with the actual started harness
          // session so SnapshotResume runs do not reuse stale IDs.
          if (existingRuntimeTaskId !== taskId) {
            const nextResult = { ...existingResult, runtimeTaskId: taskId };
            await sdk.taskRuns.update({ id: taskRun.id, result: nextResult });
            taskRun.result = nextResult;
          }

          await recordWorkerRuntimeEvent({
            eventType: 'started',
            message: `Registered runtime task ${taskId} for task run #${taskRun.id}.`,
            details: {
              runtimeTaskId: taskId,
              harness: harnessType,
              resumedFromSnapshot: Boolean(harnessSessionId),
            },
          });

          await callbacks.onStart?.(taskRun, taskId, context);
        },
        onExit: async () => {
          await recordWorkerRuntimeEvent({
            eventType: 'decision',
            message: `Worker onExit started for task run #${taskRun.id}.`,
            details: {
              runtimeTaskId: harnessManager?.getStatus().sessionId ?? null,
            },
          });
          await persistRuntimeState.flush();
          await recordWorkerRuntimeEvent({
            eventType: 'decision',
            message: `Worker onExit finished runtime-state flush for task run #${taskRun.id}.`,
          });
          await sdk.taskRuns.done({
            id: taskRun.id,
            status: RunStatus.Idle,
          });
        },
      },
    });
    taskCancellation.bindCancelTask(() => {
      // Polling/MCP cancel stamps canceledAt on the run row — that is a
      // terminal intent, so shut the sandbox down instead of leaving a soft
      // resume hold that outlives the canceled task.
      harnessManager?.cancelTask({ terminate: true });
    });
    // Close the loop on background environment setup: when it settles while
    // the agent is actively working, push a notification into the session so
    // the agent can stop polling `.roomote/setup-status.json` and continue.
    // Delivery is deferred until the runtime signals taskStarted — the phase
    // flips to running before the StartNewTask command carrying the initial
    // prompt is delivered, so injecting earlier can race the initial user
    // prompt and replace it as the session's first message. While a
    // structured question is outstanding (waiting_for_user_input), hold the
    // notice instead of injecting: an unsolicited system turn at that point
    // made agents re-issue the pending request_user_input, which Slack
    // rendered as duplicate questions (#661). A held notice is retried on the
    // next phase change once the answer arrives. A task that settled to
    // waiting_for_prompt is woken with an idle-aware variant — it may have
    // ended its turn reporting itself blocked on setup — while stopped or
    // shutting-down tasks drop the notice; .roomote/setup-status.json keeps
    // the ground truth either way.
    let pendingEnvironmentSetupOutcome:
      | EnvironmentSetupSettledOutcome
      | undefined;
    let runtimeTaskStartedForSetupNotice = false;

    const getActiveGoalContext = async () => {
      const goal = await sdk.taskRuns.getGoal({ runId: taskRun.id });
      return goal?.status === 'active' ? goal : undefined;
    };

    const deliverEnvironmentSetupNotice = async () => {
      const currentManager = harnessManager;
      const outcome = pendingEnvironmentSetupOutcome;

      if (!currentManager || !outcome || !runtimeTaskStartedForSetupNotice) {
        return;
      }

      const phase = currentManager.getStatus().phase;

      if (phase === 'waiting_for_user_input') {
        // Keep the outcome pending; answering the question flips the phase
        // back to running, and that stateChange retries delivery.
        return;
      }

      // A task that settled to waiting_for_prompt while setup was still
      // running may have ended its turn reporting itself blocked on setup, so
      // wake it with an idle-aware notice instead of dropping the outcome.
      // Any other non-running phase (stopped, shutting down) stays dropped.
      const wakeFromIdle = phase === 'waiting_for_prompt';

      if (phase !== 'running' && !wakeFromIdle) {
        pendingEnvironmentSetupOutcome = undefined;
        return;
      }

      // Claim before the async lookup so concurrent state events cannot
      // deliver the same setup outcome more than once.
      pendingEnvironmentSetupOutcome = undefined;

      let goalContext;
      try {
        goalContext = await getActiveGoalContext();
      } catch (error) {
        pendingEnvironmentSetupOutcome ??= outcome;
        logger.warn(
          `[runTask] Delaying background environment setup notice for task run ${taskRun.id} because active goal lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      const sent = currentManager.sendFollowUpPrompt({
        prompt: wakeFromIdle
          ? buildEnvironmentSetupSettledWakePrompt(outcome)
          : buildEnvironmentSetupSettledPrompt(outcome),
        visibleInTranscript: false,
        source: 'environment-setup',
        goalContext,
      });

      if (!sent) {
        pendingEnvironmentSetupOutcome ??= outcome;
      }

      void recordWorkerRuntimeEvent({
        eventType: 'decision',
        message: `Background environment setup settled (${outcome.status}) while task run #${taskRun.id} was ${wakeFromIdle ? 'idle' : 'running'}; in-session ${wakeFromIdle ? 'wake-up' : 'notification'} ${sent ? 'delivered' : 'was not accepted by the harness'}.`,
        details: {
          reason: 'background_environment_setup_notification',
          outcome: outcome.status,
          delivered: sent,
          wakeFromIdle,
        },
      });
    };

    backgroundEnvironmentSetup?.onSettled((outcome) => {
      pendingEnvironmentSetupOutcome = outcome;
      void deliverEnvironmentSetupNotice();
    });
    harnessManager.on('taskStateEvent', (eventName) => {
      if (eventName === 'taskStarted') {
        runtimeTaskStartedForSetupNotice = true;
        void deliverEnvironmentSetupNotice();
      }
    });
    harnessManager.on('stateChange', () => {
      void deliverEnvironmentSetupNotice();
    });
    harnessManager.on('taskStateEvent', (eventName) => {
      void recordWorkerRuntimeEvent({
        eventType: 'decision',
        message: `Observed harness task state event ${eventName} for task run #${taskRun.id}.`,
        details: buildWorkerTaskEventDetails({
          eventName,
          taskPhase: harnessManager.getStatus().phase ?? null,
          isConnected: harnessManager.getStatus().isConnected,
          runtimeTaskId: harnessManager.getStatus().sessionId,
        }),
      });
    });
    harnessManager.on('shutdown', (state) => {
      const sleepAt = harnessManager.getSleepAt();

      void recordWorkerRuntimeEvent({
        eventType: 'decision',
        message: `Harness manager signaled shutdown for task run #${taskRun.id}.`,
        details: buildWorkerRuntimeStateDetails({
          reason: 'harness_shutdown',
          taskPhase: harnessManager.getStatus().phase ?? null,
          sleepAt,
          keepaliveMs,
          sandboxTimeoutMs,
          sandboxExpiresAtMs: Number.isFinite(sandboxExpiresAtMs)
            ? sandboxExpiresAtMs
            : undefined,
          isConnected: harnessManager.getStatus().isConnected,
          runtimeTaskId: state.sessionId,
          cancelTriggeredAt: state.cancelTriggeredAt,
          lastMessageAt: state.lastMessageAt,
          taskFinishedAt: state.taskFinishedAt,
          taskAbortedAt: state.taskAbortedAt,
          clientDisconnectedAt: state.clientDisconnectedAt,
          lastErrorMessage: state.lastErrorMessage,
        }),
      });
    });

    let deferredResumePromptRetryTimer: NodeJS.Timeout | null = null;

    const stampRuntimeTaskStartedAt = async () => {
      try {
        await sdk.taskRuns.stampMilestone({
          runId: taskRun.id,
          field: 'runtimeTaskStartedAt',
        });
      } catch (error) {
        logger.warn(
          `[runTask] Failed to stamp runtimeTaskStartedAt for task run ${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const clearDeferredResumePromptRetryTimer = () => {
      if (!deferredResumePromptRetryTimer) {
        return;
      }

      clearTimeout(deferredResumePromptRetryTimer);
      deferredResumePromptRetryTimer = null;
    };

    const updateDeferredResumePromptResult = async (options: {
      accepted: boolean;
    }) => {
      const latestResult =
        taskRun.result &&
        typeof taskRun.result === 'object' &&
        !Array.isArray(taskRun.result)
          ? (taskRun.result as Record<string, unknown>)
          : {};

      const nextResult = {
        ...latestResult,
        deferredResumePromptAccepted: options.accepted,
        ...(options.accepted
          ? {
              deferredResumePromptAcceptedAt: new Date().toISOString(),
            }
          : {}),
      };

      if (!options.accepted) {
        delete nextResult.deferredResumePromptAcceptedAt;
      }

      await sdk.taskRuns.update({ id: taskRun.id, result: nextResult });
      taskRun.result = nextResult;
    };

    const scheduleDeferredResumePromptRetry = (options: {
      prompt: string;
      images?: string[];
      workflowPhase?: string;
      source?: string;
      clientMessageId?: string;
      userId?: string;
    }) => {
      if (deferredResumePromptRetryTimer) {
        return;
      }

      logger.info(
        `[runTask] Retrying blocked deferred resume prompt for task run ${taskRun.id} in ${DEFERRED_RESUME_PROMPT_RETRY_MS}ms`,
      );

      deferredResumePromptRetryTimer = setTimeout(() => {
        deferredResumePromptRetryTimer = null;
        void deliverDeferredResumePrompt(options);
      }, DEFERRED_RESUME_PROMPT_RETRY_MS);
      deferredResumePromptRetryTimer.unref?.();
    };

    const deliverDeferredResumePrompt = async (options: {
      prompt: string;
      images?: string[];
      workflowPhase?: string;
      source?: string;
      clientMessageId?: string;
      userId?: string;
    }) => {
      const deferredPromptPrep = await prepareActorScopedTurn(options.userId, {
        onMismatch: 'skip',
      });

      if (deferredPromptPrep === false) {
        logger.info(
          `[runTask] Deferred resume prompt blocked for task run ${taskRun.id}; keeping it queued for retry`,
        );
        scheduleDeferredResumePromptRetry(options);
        return false;
      }

      if (deferredPromptPrep.skippedMismatch) {
        // The resume prompt's sender is no longer the run's acting user (a
        // trusted write switched the actor after the resume was enqueued).
        // Retrying cannot converge, so drop the prompt; the sender was asked
        // to resend via the mismatch notice.
        clearDeferredResumePromptRetryTimer();
        await updateDeferredResumePromptResult({ accepted: false });
        logger.warn(
          `[runTask] Deferred resume prompt skipped for task run ${taskRun.id}: sender is not the server-side acting user`,
        );
        return false;
      }

      clearDeferredResumePromptRetryTimer();

      const workflowPhase =
        options.workflowPhase ?? getFollowUpWorkflowPhase(options.prompt);
      let goalContext;
      try {
        goalContext = await getActiveGoalContext();
      } catch (error) {
        logger.warn(
          `[runTask] Deferred resume prompt blocked for task run ${taskRun.id} because active goal lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        scheduleDeferredResumePromptRetry(options);
        return false;
      }
      const queued = harnessManager.sendFollowUpPrompt({
        prompt: options.prompt,
        images: options.images,
        ...(workflowPhase ? { workflowPhase } : {}),
        autoSteerWhenQueued: true,
        source: options.source,
        clientMessageId: options.clientMessageId,
        // Attribute the turn to the identity actor-scoped routes resolve.
        userId: deferredPromptPrep.effectiveUserId ?? undefined,
        goalContext,
      });

      if (queued) {
        recordSandboxPromptSlackTurnStart({
          clientMessageId: options.clientMessageId,
          source: options.source,
          stateFilePath: mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
        });
        await updateDeferredResumePromptResult({ accepted: true });
        logger.info(
          `[runTask] Deferred resume prompt accepted for task run ${taskRun.id}`,
        );
        return true;
      }

      await updateDeferredResumePromptResult({ accepted: false });
      logger.info(
        `[runTask] Deferred resume prompt rejected for task run ${taskRun.id}`,
      );
      return false;
    };

    const sendPrompt = async (options: {
      prompt: string;
      images?: string[];
      workflowPhase?: string;
      autoSteerWhenQueued?: boolean;
      queueOnly?: boolean;
      visibleInTranscript?: boolean;
      source?: string;
      userId?: string;
      userName?: string;
      userImageUrl?: string;
      clientMessageId?: string;
    }) => {
      const workflowPhase =
        options.workflowPhase ?? getFollowUpWorkflowPhase(options.prompt);

      try {
        return harnessManager.sendFollowUpPrompt({
          ...options,
          ...(workflowPhase ? { workflowPhase } : {}),
          goalContext: await getActiveGoalContext(),
        });
      } catch (error) {
        logger.warn(
          `[runTask] Follow-up prompt blocked for task run ${taskRun.id} because active goal lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    };

    const deliverQueuedSnapshotResumeSlackMessages = async (
      messages: QueuedSnapshotResumeSlackMessage[],
    ) => {
      if (messages.length === 0) {
        return;
      }

      const deliveryOrder = [...messages].reverse();
      let index = 0;

      while (index < deliveryOrder.length) {
        const message = deliveryOrder[index]!;
        const turnPrep = await prepareActorScopedTurn(message.userId, {
          allowMcpReconnect:
            !pollingState.phase ||
            pollingState.isConnected === false ||
            pollingState.phase === 'waiting_for_prompt',
          // Replayed queue entries have no trusted per-message actor write;
          // a mismatched sender's content is skipped (with a resend notice)
          // rather than run under the server actor or stalling the replay.
          onMismatch: 'skip',
        });

        if (turnPrep === false) {
          const remainingQueueOrder = [...deliveryOrder.slice(index)].reverse();
          await prependSlackMessages(taskRun.id, remainingQueueOrder);
          logger.warn(
            `[runTask] Requeued ${remainingQueueOrder.length} embedded Slack resume message(s) for task run ${taskRun.id} because actor-scoped turn preparation is blocked`,
          );
          return;
        }

        if (turnPrep.skippedMismatch) {
          index += 1;
          continue;
        }

        const prompt =
          message.formattedPrompt ??
          wrapSlackMessage(stripLeadingSlackProductMention(message.text), {
            ts: message.ts,
          });
        const sent = await sendPrompt({
          prompt,
          images: message.images,
          autoSteerWhenQueued: true,
          source: 'slack',
          // Attribute the turn to the identity actor-scoped routes resolve.
          userId: turnPrep.effectiveUserId ?? undefined,
        });

        if (!sent) {
          const remainingQueueOrder = [...deliveryOrder.slice(index)].reverse();
          await prependSlackMessages(taskRun.id, remainingQueueOrder);
          logger.warn(
            `[runTask] Requeued ${remainingQueueOrder.length} embedded Slack resume message(s) for task run ${taskRun.id} after follow-up delivery failed`,
          );
          return;
        }

        recordChatTurnStart({
          turnMessageTs: message.ts,
          allowReaction: message.turnPolicy?.reactionsAllowed,
          sessionId: pollingState.sessionId,
          stateFilePath: mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
        });

        index += 1;
      }

      logger.info(
        `[runTask] Delivered ${deliveryOrder.length} embedded Slack resume message(s) for task run ${taskRun.id}`,
      );
    };

    const requeueQueuedSnapshotResumeCommunicationMessages = async (
      messages: QueuedSnapshotResumeCommunicationMessage[],
    ) => {
      const messagesByProvider = new Map<
        CommunicationProvider,
        QueuedCommunicationMessage[]
      >();

      for (const message of messages) {
        const providerMessages = messagesByProvider.get(message.provider) ?? [];
        providerMessages.push(message);
        messagesByProvider.set(message.provider, providerMessages);
      }

      await Promise.all(
        Array.from(messagesByProvider.entries()).map(([provider, messages]) =>
          prependCommunicationMessages(provider, taskRun.id, messages),
        ),
      );
    };

    const deliverQueuedSnapshotResumeCommunicationMessages = async (
      messages: QueuedSnapshotResumeCommunicationMessage[],
    ) => {
      if (messages.length === 0) {
        return;
      }

      const deliveryOrder = [...messages].reverse();
      let index = 0;

      while (index < deliveryOrder.length) {
        const message = deliveryOrder[index]!;
        const turnPrep = await prepareActorScopedTurn(message.userId, {
          allowMcpReconnect:
            !pollingState.phase ||
            pollingState.isConnected === false ||
            pollingState.phase === 'waiting_for_prompt',
          // Replayed queue entries have no trusted per-message actor write;
          // a mismatched sender's content is skipped (with a resend notice)
          // rather than run under the server actor or stalling the replay.
          onMismatch: 'skip',
        });

        if (turnPrep === false) {
          const remainingQueueOrder = [...deliveryOrder.slice(index)].reverse();
          await requeueQueuedSnapshotResumeCommunicationMessages(
            remainingQueueOrder,
          );
          logger.warn(
            `[runTask] Requeued ${remainingQueueOrder.length} embedded communication resume message(s) for task run ${taskRun.id} because actor-scoped turn preparation is blocked`,
          );
          return;
        }

        if (turnPrep.skippedMismatch) {
          index += 1;
          continue;
        }

        const prompt =
          message.formattedPrompt ??
          (message.provider === 'slack'
            ? wrapSlackMessage(stripLeadingSlackProductMention(message.text), {
                ts: message.ts,
              })
            : wrapCommunicationMessage(message.provider, message));
        const sent = await sendPrompt({
          prompt,
          images: message.images,
          autoSteerWhenQueued: true,
          source: message.provider,
          // Attribute the turn to the identity actor-scoped routes resolve.
          userId: turnPrep.effectiveUserId ?? undefined,
          clientMessageId: `${message.provider}:${message.ts}`,
        });

        if (!sent) {
          const remainingQueueOrder = [...deliveryOrder.slice(index)].reverse();
          await requeueQueuedSnapshotResumeCommunicationMessages(
            remainingQueueOrder,
          );
          logger.warn(
            `[runTask] Requeued ${remainingQueueOrder.length} embedded communication resume message(s) for task run ${taskRun.id} after follow-up delivery failed`,
          );
          return;
        }

        if (
          message.provider === 'slack' ||
          message.provider === 'telegram' ||
          message.provider === 'teams' ||
          message.provider === 'discord'
        ) {
          recordChatTurnStart({
            turnMessageTs: message.ts,
            allowReaction: message.turnPolicy?.reactionsAllowed,
            sessionId: pollingState.sessionId,
            stateFilePath:
              mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
          });
        }

        index += 1;
      }

      logger.info(
        `[runTask] Delivered ${deliveryOrder.length} embedded communication resume message(s) for task run ${taskRun.id}`,
      );
    };

    const deliverQueuedSnapshotResumeLinearMessages = async (
      messages: LinearSessionMessage[],
    ) => {
      if (messages.length === 0) {
        return;
      }

      for (const [index, message] of messages.entries()) {
        const text =
          message.action === 'prompted' &&
          message.payload.agentActivity?.content?.body
            ? message.payload.agentActivity.content.body
            : message.payload.agentSession.issue.description || '';

        const turnPrep = await prepareActorScopedTurn(message.userId, {
          allowMcpReconnect:
            !pollingState.phase ||
            pollingState.isConnected === false ||
            pollingState.phase === 'waiting_for_prompt',
          // Replayed queue entries have no trusted per-message actor write;
          // a mismatched sender's content is skipped (with a resend notice)
          // rather than run under the server actor or stalling the replay.
          onMismatch: 'skip',
        });

        if (turnPrep === false) {
          const remainingMessages = messages.slice(index);
          await prependLinearMessages(taskRun.id, remainingMessages);
          logger.warn(
            `[runTask] Requeued ${remainingMessages.length} embedded Linear resume message(s) for task run ${taskRun.id} because actor-scoped turn preparation is blocked`,
          );
          return;
        }

        if (turnPrep.skippedMismatch) {
          continue;
        }

        const sent = await sendPrompt({
          prompt: text,
          source: 'linear',
          // Attribute the turn to the identity actor-scoped routes resolve.
          userId: turnPrep.effectiveUserId ?? undefined,
        });

        if (!sent) {
          const remainingMessages = messages.slice(index);
          await prependLinearMessages(taskRun.id, remainingMessages);
          logger.warn(
            `[runTask] Requeued ${remainingMessages.length} embedded Linear resume message(s) for task run ${taskRun.id} after follow-up delivery failed`,
          );
          return;
        }
      }

      logger.info(
        `[runTask] Delivered ${messages.length} embedded Linear resume message(s) for task run ${taskRun.id}`,
      );
    };

    const answerUserInputRequest = (options: {
      requestId: string;
      answers: AcpRequestUserInputAnswers;
      userId?: string;
    }) => harnessManager.answerUserInputRequest(options);

    const sandboxServer = createServer({
      port: SANDBOX_SERVER_PORT,
      workingDirectory: workspacePath,
      harnessLogger: logger,
      userEnv: () => workerEnv.buildUserFacingEnv(),
      harness,
      harnessManager,
      runId: taskRun.id,
      taskRunTaskId: taskRun.taskId,
      slackReplySatisfactionStateFile:
        mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
      codingHarness: harnessType,
      workerEnv,
      taskRuntime: { homeDir, runtimeEnv },
      allowTerminal: runtimeEnv.ROOMOTE_TASK_TERMINAL === 'true',
      prepareActorScopedTurn,
      applyTaskModelSettingsUpdate,
      validateToken,
    });

    logger.log(
      `[runTask] Sandbox server started on port ${SANDBOX_SERVER_PORT}`,
    );

    await sdk.taskRuns.update({
      id: taskRun.id,
      status: RunStatus.Running,
    });
    await callbacks.onStatus?.(taskRun, RunStatus.Running, context);

    // Subscribe to HarnessManager state changes BEFORE starting/resuming a task
    // so we capture the initial stateChange event (which carries sessionId).
    syncPollingState(harnessManager, pollingState, persistRuntimeState);

    logger.info(
      `[runTask] Initial input: promptChars=${initialPrompt.length} imageCount=${images?.length ?? 0} harnessSessionId=${harnessSessionId ?? 'none'}`,
    );

    if (taskCancellation.signal.aborted) {
      logger.info(
        `[runTask] Skipping initial task start for task run ${taskRun.id} because cancellation was requested during startup`,
      );
      const subprocess = getSubprocess();
      clearDeferredResumePromptRetryTimer();
      await unsubscribeHarness();
      logger.info('[runTask] Stopping sandbox server before task activation');
      await sandboxServer.close();
      harnessManager.dispose();
      harness.dispose?.();

      if (subprocess) {
        await awaitSubprocess({
          subprocess,
          controller: taskCancellation.abortController,
          logger,
        });
      } else {
        taskCancellation.abortController.abort();
      }

      return {
        status: RunStatus.Canceled,
        error: 'Task aborted',
      };
    } else if (harnessSessionId) {
      const existingResult =
        taskRun.result &&
        typeof taskRun.result === 'object' &&
        !Array.isArray(taskRun.result)
          ? (taskRun.result as Record<string, unknown>)
          : {};

      const nextResult = {
        ...existingResult,
        runtimeTaskId: harnessSessionId,
      };
      await sdk.taskRuns.update({ id: taskRun.id, result: nextResult });
      taskRun.result = nextResult;
      harnessManager.resumeTask(harnessSessionId);
      await stampRuntimeTaskStartedAt();
      pollingState.sessionId = harnessSessionId;
      pollingState.phase = 'waiting_for_prompt';

      try {
        await callbacks.onStart?.(taskRun, harnessSessionId, context);
      } catch (error) {
        logger.warn(
          `[runTask] Resume onStart callback failed for task run ${taskRun.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const resumePayload =
        taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
        taskRun.payload &&
        typeof taskRun.payload === 'object'
          ? (taskRun.payload as Record<string, unknown>)
          : null;
      const deferredResumePrompt =
        typeof resumePayload?.resumePrompt === 'string'
          ? resumePayload.resumePrompt.trim()
          : '';
      const deferredResumePromptSource =
        typeof resumePayload?.resumePromptSource === 'string'
          ? resumePayload.resumePromptSource
          : undefined;
      const deferredResumePromptClientMessageId =
        typeof resumePayload?.resumePromptClientMessageId === 'string'
          ? resumePayload.resumePromptClientMessageId
          : undefined;
      const deferredResumePromptUserId =
        typeof resumePayload?.resumePromptUserId === 'string'
          ? resumePayload.resumePromptUserId
          : undefined;
      const deferredResumePromptImages = Array.isArray(
        resumePayload?.resumePromptImages,
      )
        ? resumePayload.resumePromptImages.filter(
            (image): image is string => typeof image === 'string',
          )
        : undefined;

      if (deferredResumePrompt.length > 0) {
        await deliverDeferredResumePrompt({
          prompt: deferredResumePrompt,
          ...(deferredResumePromptImages?.length
            ? { images: deferredResumePromptImages }
            : {}),
          source: deferredResumePromptSource,
          clientMessageId: deferredResumePromptClientMessageId,
          userId: deferredResumePromptUserId,
        });
      }

      await deliverQueuedSnapshotResumeSlackMessages(
        getQueuedSnapshotResumeSlackMessages(resumePayload),
      );
      await deliverQueuedSnapshotResumeCommunicationMessages(
        getQueuedSnapshotResumeCommunicationMessages(resumePayload),
      );
      await deliverQueuedSnapshotResumeLinearMessages(
        getQueuedSnapshotResumeLinearMessages(resumePayload),
      );
    } else if (hasInitialPrompt || hasInitialImages) {
      harnessManager.startNewTask({
        prompt: initialPrompt,
        images,
        ...(initialWorkflowPhase
          ? { workflowPhase: initialWorkflowPhase }
          : {}),
        visibleInTranscript: false,
        ...(task?.goal?.status === 'active' ? { goalContext: task.goal } : {}),
      });
    } else {
      // Session mode: initialize without prompt.
      harnessManager.initializeWithoutPrompt();
    }

    // Start polling for cancellation and integration events.
    // Polling uses the worker's RunTaskState for interval tracking.
    // (syncPollingState was already called above, before task start/resume.)
    startPolling({
      taskRun,
      task,
      state: pollingState,
      logger,
      workingDirectory: workspacePath,
      cancelTask: () => taskCancellation.abort('polling-cancel-requested'),
      sendPrompt,
      slackReplySatisfactionStateFile:
        mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
      answerUserInputRequest,
      prepareActorScopedTurn,
      getVisibleQueuedPromptCount: () =>
        harness.getQueuedMessages?.().length ?? 0,
    });

    // Wait for HarnessManager to signal that the container should shut down.
    // The harness emits 'disconnected' on subprocess exit, so the manager
    // detects completion for both CLI and extension runtimes.
    const finalTaskState = await harnessManager.waitForShutdown();
    clearDeferredResumePromptRetryTimer();
    await stopPolling(pollingState);
    await unsubscribeHarness();

    logger.info('[runTask] Stopping sandbox server');
    await sandboxServer.close();
    harnessManager.dispose();

    // Map TaskState to RunTaskState for resolve-status compatibility.
    const finalState: RunTaskState = { ...pollingState, ...finalTaskState };
    const resolvedResult = resolveStatus(finalState);

    // Wait for BullMQ to pick up the authoritative sleep deadline and claim the
    // external sleep action. BullMQ is responsible for both resumable snapshots
    // and non-resumable shutdowns across snapshot-capable providers.
    //
    // Terminal cancel must skip this handoff: publish no due sleepAt and
    // finish as Canceled instead of becoming a snapshot/standby candidate.
    // Failed turns still use the ordinary idle retention path so a model or
    // provider error cannot discard an otherwise healthy workspace.
    //
    // NOTE: Snapshot creation ultimately tears down the provider runtime. Vercel
    // does this as part of snapshot creation, while Modal explicitly terminates
    // the sandbox immediately after snapshotting. In practice, the code below
    // will usually NOT execute after a successful snapshot because the worker is
    // terminated while the handoff helper is polling.
    //
    // The BullMQ snapshot handler (apps/bullmq/src/jobs/snapshot.ts) is the
    // primary mechanism for post-snapshot cleanup (e.g., draining pending Linear
    // messages). The drain check below is kept as a fallback for edge cases where
    // the snapshot fails or times out but the worker survives.
    const skipSleepAfterTerminalCancel = Boolean(finalState.cancelTriggeredAt);
    const skipSleepWithoutRetentionDeadline =
      resolvedResult.status === RunStatus.Failed &&
      harnessManager.getSleepAt() == null;
    if (skipSleepAfterTerminalCancel) {
      logger.info(
        `[runTask] Skipping external sleep handoff after terminal cancel for task run ${taskRun.id}`,
      );
    }
    if (skipSleepWithoutRetentionDeadline && !skipSleepAfterTerminalCancel) {
      logger.info(
        `[runTask] Skipping external sleep handoff without a retention deadline for task run ${taskRun.id}`,
      );
    }

    let sleepActionTriggered = false;
    let sleepActionCompleted = false;

    if (
      !skipExternalSleepAction &&
      !skipSleepAfterTerminalCancel &&
      !skipSleepWithoutRetentionDeadline
    ) {
      // BullMQ may claim the sleep action and snapshot the filesystem while
      // the handoff helper polls below. The harness has already shut down, so
      // drop on-disk credential material first; resume re-injects it from the
      // dequeue response.
      await scrubSandboxSecretsBeforeSnapshot(logger, { homeDir, runtimeEnv });

      ({ claimed: sleepActionTriggered, completed: sleepActionCompleted } =
        await waitForExternalSleepAction({
          taskRun,
          logger,
        }));
    }

    // Fallback: check for pending Linear messages that arrived during the snapshot
    // window. In practice, the provider runtime is torn down during or
    // immediately after snapshot creation, so this code only runs if the
    // snapshot failed/timed out and the worker survived. The primary drain path
    // is in the BullMQ snapshot handler.
    if (
      sleepActionTriggered &&
      (taskRun.payloadKind === TaskPayloadKind.LinearAgentSession ||
        (taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
          !!(
            task?.linearSessionId ??
            getLinearSessionIdFromResumePayload(taskRun.payload)
          )))
    ) {
      try {
        const result = await sdk.linearSessions.drainLinearMessages({
          runId: taskRun.id,
        });

        if (result.resumed) {
          logger.info(
            `[runTask] Created resume task run ${result.runId} for ${result.messageCount} pending Linear message(s) drained from job ${taskRun.id}`,
          );
        } else {
          logger.info(
            `[runTask] Linear drain check: ${result.reason} (job ${taskRun.id})`,
          );
        }
      } catch (error) {
        logger.warn(
          `[runTask] Failed to drain Linear messages for job ${taskRun.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Belt-and-suspenders drain for Slack messages (same pattern as Linear above).
    // Some Slack-linked jobs learn their thread ts after the worker starts, so use
    // channel metadata here and let the SDK re-read the authoritative DB row.
    if (
      sleepActionTriggered &&
      (task?.slackThreadTs ||
        task?.slackChannelId ||
        getSlackThreadTsFromTaskPayload(taskRun.payload) ||
        getSlackChannelFromTaskPayload(taskRun.payload))
    ) {
      try {
        const result = await sdk.slackInstallations.drainSlackMessages({
          runId: taskRun.id,
        });

        if (result.resumed) {
          logger.info(
            `[runTask] Created resume task run ${result.runId} for ${result.messageCount} pending Slack message(s) drained from job ${taskRun.id}`,
          );
        } else {
          logger.info(
            `[runTask] Slack drain check: ${result.reason} (job ${taskRun.id})`,
          );
        }
      } catch (error) {
        logger.warn(
          `[runTask] Failed to drain Slack messages for job ${taskRun.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const subprocess = getSubprocess();
    if (subprocess) {
      await awaitSubprocess({
        subprocess,
        controller: taskCancellation.abortController,
        logger,
      });
    } else {
      taskCancellation.abortController.abort();
    }
    // BullMQ owns terminal state after a completed snapshot/standby handoff.
    // Do not let a stale pre-handoff failure overwrite that completion if the
    // provider leaves this worker alive long enough to return normally.
    return sleepActionCompleted
      ? { status: RunStatus.Completed }
      : resolvedResult;
  } finally {
    activeWorkerCrashContext = null;
  }
};

/**
 * Sync HarnessManager state changes back to the polling RunTaskState so that
 * cancel polling can check sessionId and cancelTriggeredAt.
 */
function syncPollingState(
  harnessManager: HarnessManager,
  pollingState: RunTaskState,
  persistRuntimeState: RuntimeStatePersister,
): void {
  harnessManager.on('stateChange', (phase, state) => {
    const previousConnectionState = pollingState.isConnected;
    pollingState.phase = phase;
    pollingState.isConnected = harnessManager.getStatus().isConnected;
    pollingState.sessionId = state.sessionId;
    pollingState.cancelTriggeredAt = state.cancelTriggeredAt;
    pollingState.lastMessageAt = state.lastMessageAt;
    pollingState.taskFinishedAt = state.taskFinishedAt;
    pollingState.taskAbortedAt = state.taskAbortedAt;
    const sleepAt = harnessManager.getSleepAt();

    persistRuntimeState({
      taskPhase: phase,
      sleepAt,
      reason: 'harness_state_change',
      isConnected: pollingState.isConnected,
      runtimeTaskId: state.sessionId,
      cancelTriggeredAt: state.cancelTriggeredAt,
      lastMessageAt: state.lastMessageAt,
      taskFinishedAt: state.taskFinishedAt,
      taskAbortedAt: state.taskAbortedAt,
      clientDisconnectedAt: state.clientDisconnectedAt,
      lastErrorMessage: state.lastErrorMessage,
    }).catch((err) => {
      console.warn(
        `[syncPollingState] Failed to update task runtime state: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    if (
      previousConnectionState !== undefined &&
      previousConnectionState !== pollingState.isConnected
    ) {
      const connectionState = pollingState.isConnected
        ? 'connected'
        : 'disconnected';

      persistRuntimeState
        .recordConnectionTransition({
          connectionState,
          phase,
          sleepAt,
          runtimeTaskId: state.sessionId,
          cancelTriggeredAt: state.cancelTriggeredAt,
          lastMessageAt: state.lastMessageAt,
          taskFinishedAt: state.taskFinishedAt,
          taskAbortedAt: state.taskAbortedAt,
          clientDisconnectedAt: state.clientDisconnectedAt,
          lastErrorMessage: state.lastErrorMessage,
        })
        .catch((err) => {
          console.warn(
            `[syncPollingState] Failed to record harness ${connectionState} event: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
  });
}

type RuntimeStatePersister = ((values: {
  taskPhase: string | null;
  sleepAt: number | null;
  reason: string;
  isConnected?: boolean;
  runtimeTaskId?: string;
  cancelTriggeredAt?: number;
  lastMessageAt?: number;
  taskFinishedAt?: number;
  taskAbortedAt?: number;
  clientDisconnectedAt?: number;
  lastErrorMessage?: string;
}) => Promise<void>) & {
  flush: () => Promise<void>;
  recordConnectionTransition: (values: {
    connectionState: 'connected' | 'disconnected';
    phase: string | null;
    sleepAt: number | null;
    runtimeTaskId?: string;
    cancelTriggeredAt?: number;
    lastMessageAt?: number;
    taskFinishedAt?: number;
    taskAbortedAt?: number;
    clientDisconnectedAt?: number;
    lastErrorMessage?: string;
  }) => Promise<void>;
};

function createRuntimeStatePersister(
  runId: number,
  recordWorkerRuntimeEvent: ReturnType<typeof createWorkerRuntimeEventRecorder>,
): RuntimeStatePersister {
  let pendingWrite = Promise.resolve();
  let pendingEventWrite = Promise.resolve();

  const enqueueEvent = (
    input: Parameters<typeof recordWorkerRuntimeEvent>[0],
  ) => {
    const runEvent = () => recordWorkerRuntimeEvent(input);
    const nextEventWrite = pendingEventWrite.then(runEvent, runEvent);
    pendingEventWrite = nextEventWrite.catch(() => {});
    return nextEventWrite;
  };

  const persist = (values: {
    taskPhase: string | null;
    sleepAt: number | null;
    reason: string;
    isConnected?: boolean;
    runtimeTaskId?: string;
    cancelTriggeredAt?: number;
    lastMessageAt?: number;
    taskFinishedAt?: number;
    taskAbortedAt?: number;
    clientDisconnectedAt?: number;
    lastErrorMessage?: string;
  }) => {
    const runWrite = async () => {
      const result = await sdk.taskRuns.updateRuntimeState({
        id: runId,
        taskPhase: values.taskPhase,
        sleepAt: values.sleepAt == null ? null : new Date(values.sleepAt),
      });

      if (!result.updated) {
        return;
      }

      void enqueueEvent({
        eventType: 'decision',
        message: `Persisted runtime state for task run #${runId}.`,
        details: buildWorkerRuntimeStateDetails(values),
      });
    };

    const nextWrite = pendingWrite.then(runWrite, runWrite);
    pendingWrite = nextWrite.catch(() => {});
    return nextWrite;
  };

  persist.flush = () => pendingWrite;
  persist.recordConnectionTransition = async (values: {
    connectionState: 'connected' | 'disconnected';
    phase: string | null;
    sleepAt: number | null;
    runtimeTaskId?: string;
    cancelTriggeredAt?: number;
    lastMessageAt?: number;
    taskFinishedAt?: number;
    taskAbortedAt?: number;
    clientDisconnectedAt?: number;
    lastErrorMessage?: string;
  }) => {
    await enqueueEvent({
      eventType: 'decision',
      message: `Harness ${values.connectionState} for task run #${runId}.`,
      details: buildWorkerRuntimeStateDetails({
        reason: `harness_${values.connectionState}`,
        taskPhase: values.phase,
        sleepAt: values.sleepAt,
        isConnected: values.connectionState === 'connected',
        runtimeTaskId: values.runtimeTaskId,
        cancelTriggeredAt: values.cancelTriggeredAt,
        lastMessageAt: values.lastMessageAt,
        taskFinishedAt: values.taskFinishedAt,
        taskAbortedAt: values.taskAbortedAt,
        clientDisconnectedAt: values.clientDisconnectedAt,
        lastErrorMessage: values.lastErrorMessage,
      }),
    });
  };

  return persist;
}
