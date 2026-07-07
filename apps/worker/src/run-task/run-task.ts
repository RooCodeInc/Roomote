import {
  type CommunicationProvider,
  type AcpRequestUserInputAnswers,
  CloudTaskStatus,
  CloudTaskType,
  type QueuedCommunicationMessage,
  getSlackChannelFromTaskPayload,
  isCommunicationProvider,
  SANDBOX_SERVER_PORT,
  SANDBOX_TIMEOUT_MS,
} from '@roomote/types';
import { FeatureFlag } from '@roomote/feature-flags';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { validateToken } from '@roomote/auth/client';
import {
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

import type { RunTaskOptions, RunTaskState } from './types';
import {
  DEFAULT_DELEGATED_KEEPALIVE_MS,
  DEFAULT_KEEPALIVE_DEV_MS,
  DEFAULT_KEEPALIVE_MS,
} from './constants';
import { buildOpenCodeHarnessEnv, sanitizeEnv } from './env';
import { startPolling, stopPolling } from './polling';
import { awaitSubprocess } from './subprocess';
import { resolveStatus } from './resolve-status';
import { getDefaultKeepaliveMs } from './completion';
import { waitForExternalSleepAction } from './wait-for-external-sleep-action';
import {
  buildWorkerRuntimeStateDetails,
  buildWorkerTaskEventDetails,
  createWorkerRuntimeEventRecorder,
} from './cloud-job-events';
import { TaskCancellationController } from './task-cancellation-controller';
import {
  activateSkillsFolder,
  resolvePackagedSkillsFolder,
} from './agent-home';

import { createHarness } from './create-harness';
import { createActorScopedMcpRefresher } from './actor-scoped-mcp-refresh';
import { buildSandboxInstruction } from './sandbox-instruction';
import {
  buildMcpTaskEnv,
  getCommunicationReplyContext,
  getSlackReplyContext,
} from './mcp-task-env';
import {
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

function getInitialSlackTurnMessageTs(cloudJob: {
  type: string;
  payload: unknown;
}): string | null {
  if (!cloudJob.payload || typeof cloudJob.payload !== 'object') {
    return null;
  }

  const payload = cloudJob.payload as {
    slackOriginMessageTs?: unknown;
    thread_ts?: unknown;
    ts?: unknown;
    communicationProvider?: unknown;
    communicationMessageId?: unknown;
  };

  // Telegram and Teams tasks track the launch message so the turn-satisfaction
  // machinery (ack/closeout enforcement, current-turn reactions) applies.
  if (
    (payload.communicationProvider === 'telegram' ||
      payload.communicationProvider === 'teams') &&
    typeof payload.communicationMessageId === 'string' &&
    payload.communicationMessageId.trim()
  ) {
    return payload.communicationMessageId.trim();
  }

  if (
    cloudJob.type !== CloudTaskType.SlackAppMention &&
    cloudJob.type !== CloudTaskType.SnapshotResume
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

  return provider === 'telegram' || provider === 'teams';
}

function shouldAllowEmojiReactionOnInitialTurn(cloudJob: {
  type: string;
  payload: unknown;
}): boolean {
  // Chat-launched tasks must answer their first turn with a real reply, not
  // just an emoji reaction.
  if (cloudJob.type === CloudTaskType.SlackAppMention) {
    return false;
  }

  return !isCommunicationLaunchPayload(cloudJob.payload);
}

function hasAutomationWorkItemId(cloudJob: { payload: unknown }): boolean {
  if (!cloudJob.payload || typeof cloudJob.payload !== 'object') {
    return false;
  }

  const payload = cloudJob.payload as {
    automationWorkItemId?: unknown;
  };

  return (
    typeof payload.automationWorkItemId === 'string' &&
    payload.automationWorkItemId.trim().length > 0
  );
}

function shouldRequireInitialAckOnInitialTurn(cloudJob: {
  payload: unknown;
}): boolean {
  return !hasAutomationWorkItemId(cloudJob);
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
 * leak listeners across `executeJob` retries: each `runTask` overwrites the
 * context on entry and clears it on its controlled exits.
 */
interface WorkerCrashContext {
  cloudJobId: number;
  logger: { error: (message: string) => void };
  /** Reads the latest cloud job result so unrelated fields are preserved. */
  getResult: () => unknown;
}

let activeWorkerCrashContext: WorkerCrashContext | null = null;
let workerCrashHandlersRegistered = false;

/**
 * Persist fatal process errors to the cloud job result before dying. The
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

  void sdk.cloudJobs
    .update({
      id: context.cloudJobId,
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
 * `executeJob` retries) never accumulate listeners.
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

const PLAN_MODE_FLAG = FeatureFlag.PlanMode;
const SLACK_PROOF_AUTO_POST_FLAG = FeatureFlag.SlackProofAutoPost;
const BACKGROUND_SUBAGENTS_FLAG = FeatureFlag.BackgroundSubagents;

export const runTask = async ({
  cloudJob,
  envVars,
  workspacePath,
  usesSharedWorkspaceRoot,
  repoPaths,
  repoLocalSkills,
  workspaceReadinessWarnings,
  prompt,
  harnessInstructions,
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
  await sdk.cloudJobs.update({
    id: cloudJob.id,
    status: CloudTaskStatus.Spawning,
  });

  // Register the process-level crash listeners (at most once per process) and
  // point them at this run via the module-level context slot. The `finally` at
  // the end of `runTask` clears the context unconditionally, so the listeners
  // can never attribute a later crash to a stale cloud job even if `runTask`
  // throws between here and a controlled exit — no per-run listeners are
  // installed, so nothing leaks across `executeJob` retries.
  ensureWorkerCrashHandlersRegistered();
  activeWorkerCrashContext = {
    cloudJobId: cloudJob.id,
    logger,
    getResult: () => cloudJob.result,
  };

  try {
    const harnessType = resolveWorkerCodingHarness(cloudJob.harness);

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
      ROOMOTE_APP_URL: workerEnv.openRoomoteAppUrl,
      ROOMOTE_PLATFORM_API_URL: workerEnv.trpcUrl,
      ROOMOTE_WORKSPACE_PATH: workspacePath,
      ROOMOTE_CLOUD_TOKEN: workerEnv.authToken,
      ROOMOTE_TASK_ID: cloudJob.taskId,
      AGENT_BROWSER_SESSION: cloudJob.taskId,
      ROOMOTE_TASK_TYPE: cloudJob.type,
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
    const workerHomeDir = runtimeEnv.HOME ?? sanitizedEnv.HOME ?? '';

    if (workerHomeDir) {
      runtimeEnv.HOME = resolveTaskRuntimeHomeDir(workspacePath);
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
      requestedWorkKind: cloudJob.requestedWorkKind,
    });
    const hasInitialPrompt = initialPrompt.trim().length > 0;
    const images =
      'images' in cloudJob.payload && cloudJob.payload.images
        ? cloudJob.payload.images
        : undefined;
    const hasInitialImages = Boolean(images?.length);

    const homeDir = runtimeEnv.HOME ?? sanitizedEnv.HOME ?? '';
    const skillsActivated = activateSkillsFolder({
      homeDir,
      sourceHomeDir: workerHomeDir,
      skillsFolderName: selectedSkillsFolder,
      manualSkills: environmentConfig?.manualSkills,
      repoLocalSkills,
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

    try {
      const planModeEnabled = await sdk.featureFlags.evaluate(PLAN_MODE_FLAG);

      if (planModeEnabled) {
        runtimeEnv.ROOMOTE_PLAN_MODE = 'true';
      }
    } catch (error) {
      logger.warn(
        `[runTask] Failed to evaluate PlanMode feature flag: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const slackProofAutoPostEnabled = await sdk.featureFlags.evaluate(
        SLACK_PROOF_AUTO_POST_FLAG,
      );

      if (slackProofAutoPostEnabled) {
        runtimeEnv.ROOMOTE_SLACK_PROOF_AUTO_POST = 'true';
      }
    } catch (error) {
      logger.warn(
        `[runTask] Failed to evaluate SlackProofAutoPost feature flag: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const backgroundSubagentsEnabled = await sdk.featureFlags.evaluate(
        BACKGROUND_SUBAGENTS_FLAG,
      );

      if (backgroundSubagentsEnabled) {
        runtimeEnv.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';
      }
    } catch (error) {
      logger.warn(
        `[runTask] Failed to evaluate BackgroundSubagents feature flag: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const slackReplyContext = getSlackReplyContext(cloudJob);
    const communicationReplyContext = getCommunicationReplyContext(cloudJob);
    if (slackReplyContext?.threadTs) {
      // Slack proof auto-post resolves its thread destination from these env
      // vars when visual-proof artifacts are uploaded through the Roomote MCP
      // server.
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
      const initialTurnMessageTs = getInitialSlackTurnMessageTs(cloudJob);
      writeFileSync(
        mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
        JSON.stringify({
          startedAtMs,
          currentTurnRequiresInitialAck:
            shouldRequireInitialAckOnInitialTurn(cloudJob),
          ...(initialTurnMessageTs
            ? {
                currentTurnMessageTs: initialTurnMessageTs,
                currentTurnStartedAtMs: startedAtMs,
                currentTurnReactionsAllowed:
                  shouldAllowEmojiReactionOnInitialTurn(cloudJob),
              }
            : {}),
          // Late-bound automation execution tasks have no inbound Slack turn,
          // but must still end with one agent-written closeout; the Stop hook
          // blocks silent completion when this flag is set.
          ...(!initialTurnMessageTs && hasAutomationWorkItemId(cloudJob)
            ? { requiresTerminalCloseoutWithoutTurn: true }
            : {}),
        }),
        'utf8',
      );
    }

    // Build sandbox environment context for the agent.
    // Reads ROOMOTE_*_HOST vars from the unsanitized env so the generated
    // environment note always sees the injected preview URLs.
    const sandboxInstruction = buildSandboxInstruction(
      Boolean(environmentConfig?.initialUrl),
      environmentConfig,
      {
        envVars,
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
    // Deliver workflow and runtime guidance through harness developer
    // instructions so startup context stays out of the first user prompt.
    const harnessDeveloperInstructions =
      [harnessInstructions, environmentInstructions]
        .filter((value): value is string => Boolean(value))
        .join('\n\n') || undefined;

    writeSharedWorkspaceAgentsFile({
      workspacePath,
      usesSharedWorkspaceRoot,
      repoPaths,
    });

    const taskCancellation = new TaskCancellationController({
      cloudJobId: cloudJob.id,
      logger,
      externalCancelSignal,
    });
    const cancelSignal = taskCancellation.signal;
    let harnessManager: HarnessManager | undefined = undefined;

    await sdk.cloudJobs.update({
      id: cloudJob.id,
      status: CloudTaskStatus.Connecting,
    });

    const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
      cloudJobId: cloudJob.id,
      logger,
    });
    const persistRuntimeState = createRuntimeStatePersister(
      cloudJob.id,
      recordWorkerRuntimeEvent,
    );
    const requestHarnessReconnect = async (options: {
      reason: string;
      afterCurrentTurn?: boolean;
    }) => await harness.requestReconnect?.(options);
    const refreshActorScopedIntegrations = createActorScopedMcpRefresher({
      cloudJob,
      integrations,
      requestReconnect: async (options) =>
        await requestHarnessReconnect?.(options),
      logger,
    });

    const prepareActorScopedTurn = async (
      targetUserId?: string,
      options?: {
        allowMcpReconnect?: boolean;
        deferReconnectUntilTurnBoundary?: boolean;
      },
    ) =>
      await prepareActorScopedTurnHelper({
        cloudJobId: cloudJob.id,
        targetUserId,
        workingDirectory: workspacePath,
        logPrefix: '[runTask]',
        allowMcpReconnect: options?.allowMcpReconnect,
        deferReconnectUntilTurnBoundary:
          options?.deferReconnectUntilTurnBoundary,
        logger,
        refreshActorScopedIntegrations,
      });

    const prepareQueuedPromptActorScope = async (targetUserId?: string) => {
      if (!targetUserId) {
        return {
          shouldReconnect: false,
        };
      }

      const didSyncActor = await syncActorScopedTurnState({
        cloudJobId: cloudJob.id,
        targetUserId,
        workingDirectory: workspacePath,
        logPrefix: '[runTask]',
        logger,
      });

      if (!didSyncActor) {
        return {
          shouldReconnect: false,
          shouldBlockPrompt: true,
          reason:
            'actor-scoped turn delivery is blocked until actingUserId can be synchronized',
        };
      }

      const refreshResult = await refreshActorScopedIntegrations(targetUserId, {
        skipReconnect: true,
      });

      if (refreshResult.didFail) {
        if (!refreshResult.actorChanged) {
          return {
            shouldReconnect: false,
            reason:
              refreshResult.reason ??
              'actor-scoped MCP refresh failed for the current actor; continuing with existing MCP state',
          };
        }

        return {
          shouldReconnect: false,
          shouldBlockPrompt: true,
          reason:
            refreshResult.reason ??
            'actor-scoped MCP refresh must succeed before the queued prompt can run',
        };
      }

      return {
        shouldReconnect: refreshResult.didChange,
        reason: refreshResult.reason,
      };
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
      cloudJob,
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
      cloudJob.keepaliveMs ??
      getDefaultKeepaliveMs({
        taskType: cloudJob.type,
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
      cloudJobId: cloudJob.id,
      taskId: cloudJob.taskId,
      logger,
      callbacks: {
        onStart: async (taskId: string) => {
          try {
            await sdk.cloudJobs.setHarnessSessionId({
              cloudJobId: cloudJob.id,
              harnessSessionId: taskId,
            });
          } catch (error) {
            logger.warn(
              `[runTask] Failed to persist harness session ID for cloud job ${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          await stampRuntimeTaskStartedAt();

          const existingResult =
            cloudJob.result &&
            typeof cloudJob.result === 'object' &&
            !Array.isArray(cloudJob.result)
              ? (cloudJob.result as Record<string, unknown>)
              : {};

          const existingRuntimeTaskId =
            typeof existingResult.runtimeTaskId === 'string'
              ? existingResult.runtimeTaskId
              : null;

          // Keep runtimeTaskId synchronized with the actual started harness
          // session so SnapshotResume jobs do not reuse stale IDs.
          if (existingRuntimeTaskId !== taskId) {
            const nextResult = { ...existingResult, runtimeTaskId: taskId };
            await sdk.cloudJobs.update({ id: cloudJob.id, result: nextResult });
            cloudJob.result = nextResult;
          }

          await recordWorkerRuntimeEvent({
            eventType: 'started',
            message: `Registered runtime task ${taskId} for cloud job #${cloudJob.id}.`,
            details: {
              runtimeTaskId: taskId,
              harness: harnessType,
              resumedFromSnapshot: Boolean(harnessSessionId),
            },
          });

          await callbacks.onStart?.(cloudJob, taskId, context);
        },
        onExit: async () => {
          await recordWorkerRuntimeEvent({
            eventType: 'decision',
            message: `Worker onExit started for cloud job #${cloudJob.id}.`,
            details: {
              runtimeTaskId: harnessManager?.getStatus().sessionId ?? null,
            },
          });
          await persistRuntimeState.flush();
          await recordWorkerRuntimeEvent({
            eventType: 'decision',
            message: `Worker onExit finished runtime-state flush for cloud job #${cloudJob.id}.`,
          });
          await sdk.cloudJobs.done({
            id: cloudJob.id,
            status: CloudTaskStatus.Idle,
          });
        },
      },
    });
    taskCancellation.bindCancelTask(() => {
      harnessManager?.cancelTask();
    });
    harnessManager.on('taskStateEvent', (eventName) => {
      void recordWorkerRuntimeEvent({
        eventType: 'decision',
        message: `Observed harness task state event ${eventName} for cloud job #${cloudJob.id}.`,
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
        message: `Harness manager signaled shutdown for cloud job #${cloudJob.id}.`,
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
        await sdk.cloudJobs.stampMilestone({
          cloudJobId: cloudJob.id,
          field: 'runtimeTaskStartedAt',
        });
      } catch (error) {
        logger.warn(
          `[runTask] Failed to stamp runtimeTaskStartedAt for cloud job ${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
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
        cloudJob.result &&
        typeof cloudJob.result === 'object' &&
        !Array.isArray(cloudJob.result)
          ? (cloudJob.result as Record<string, unknown>)
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

      await sdk.cloudJobs.update({ id: cloudJob.id, result: nextResult });
      cloudJob.result = nextResult;
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
        `[runTask] Retrying blocked deferred resume prompt for cloud job ${cloudJob.id} in ${DEFERRED_RESUME_PROMPT_RETRY_MS}ms`,
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
      const canDeliverDeferredResumePrompt = await prepareActorScopedTurn(
        options.userId,
      );

      if (!canDeliverDeferredResumePrompt) {
        logger.info(
          `[runTask] Deferred resume prompt blocked for cloud job ${cloudJob.id}; keeping it queued for retry`,
        );
        scheduleDeferredResumePromptRetry(options);
        return false;
      }

      clearDeferredResumePromptRetryTimer();

      const workflowPhase =
        options.workflowPhase ?? getFollowUpWorkflowPhase(options.prompt);
      const queued = harnessManager.sendFollowUpPrompt({
        prompt: options.prompt,
        images: options.images,
        ...(workflowPhase ? { workflowPhase } : {}),
        autoSteerWhenQueued: true,
        source: options.source,
        clientMessageId: options.clientMessageId,
        userId: options.userId,
      });

      if (queued) {
        recordSandboxPromptSlackTurnStart({
          clientMessageId: options.clientMessageId,
          source: options.source,
          stateFilePath: mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
        });
        await updateDeferredResumePromptResult({ accepted: true });
        logger.info(
          `[runTask] Deferred resume prompt accepted for cloud job ${cloudJob.id}`,
        );
        return true;
      }

      await updateDeferredResumePromptResult({ accepted: false });
      logger.info(
        `[runTask] Deferred resume prompt rejected for cloud job ${cloudJob.id}`,
      );
      return false;
    };

    const sendPrompt = (options: {
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

      return harnessManager.sendFollowUpPrompt({
        ...options,
        ...(workflowPhase ? { workflowPhase } : {}),
      });
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
        const canDeliver =
          (await prepareActorScopedTurn(message.userId, {
            allowMcpReconnect:
              !pollingState.phase ||
              pollingState.isConnected === false ||
              pollingState.phase === 'waiting_for_prompt',
          })) !== false;

        if (!canDeliver) {
          const remainingQueueOrder = [...deliveryOrder.slice(index)].reverse();
          await prependSlackMessages(cloudJob.id, remainingQueueOrder);
          logger.warn(
            `[runTask] Requeued ${remainingQueueOrder.length} embedded Slack resume message(s) for cloud job ${cloudJob.id} because actor-scoped turn preparation is blocked`,
          );
          return;
        }

        const prompt =
          message.formattedPrompt ??
          wrapSlackMessage(stripLeadingSlackProductMention(message.text), {
            ts: message.ts,
          });
        const sent = sendPrompt({
          prompt,
          images: message.images,
          autoSteerWhenQueued: true,
          source: 'slack',
          userId: message.userId,
        });

        if (!sent) {
          const remainingQueueOrder = [...deliveryOrder.slice(index)].reverse();
          await prependSlackMessages(cloudJob.id, remainingQueueOrder);
          logger.warn(
            `[runTask] Requeued ${remainingQueueOrder.length} embedded Slack resume message(s) for cloud job ${cloudJob.id} after follow-up delivery failed`,
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
        `[runTask] Delivered ${deliveryOrder.length} embedded Slack resume message(s) for cloud job ${cloudJob.id}`,
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
          prependCommunicationMessages(provider, cloudJob.id, messages),
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
        const canDeliver =
          (await prepareActorScopedTurn(message.userId, {
            allowMcpReconnect:
              !pollingState.phase ||
              pollingState.isConnected === false ||
              pollingState.phase === 'waiting_for_prompt',
          })) !== false;

        if (!canDeliver) {
          const remainingQueueOrder = [...deliveryOrder.slice(index)].reverse();
          await requeueQueuedSnapshotResumeCommunicationMessages(
            remainingQueueOrder,
          );
          logger.warn(
            `[runTask] Requeued ${remainingQueueOrder.length} embedded communication resume message(s) for cloud job ${cloudJob.id} because actor-scoped turn preparation is blocked`,
          );
          return;
        }

        const prompt =
          message.formattedPrompt ??
          (message.provider === 'slack'
            ? wrapSlackMessage(stripLeadingSlackProductMention(message.text), {
                ts: message.ts,
              })
            : wrapCommunicationMessage(message.provider, message));
        const sent = sendPrompt({
          prompt,
          images: message.images,
          autoSteerWhenQueued: true,
          source: message.provider,
          userId: message.userId,
          clientMessageId: `${message.provider}:${message.ts}`,
        });

        if (!sent) {
          const remainingQueueOrder = [...deliveryOrder.slice(index)].reverse();
          await requeueQueuedSnapshotResumeCommunicationMessages(
            remainingQueueOrder,
          );
          logger.warn(
            `[runTask] Requeued ${remainingQueueOrder.length} embedded communication resume message(s) for cloud job ${cloudJob.id} after follow-up delivery failed`,
          );
          return;
        }

        if (
          message.provider === 'slack' ||
          message.provider === 'telegram' ||
          message.provider === 'teams'
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
        `[runTask] Delivered ${deliveryOrder.length} embedded communication resume message(s) for cloud job ${cloudJob.id}`,
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

        const canDeliver =
          (await prepareActorScopedTurn(message.userId, {
            allowMcpReconnect:
              !pollingState.phase ||
              pollingState.isConnected === false ||
              pollingState.phase === 'waiting_for_prompt',
          })) !== false;

        if (!canDeliver) {
          const remainingMessages = messages.slice(index);
          await prependLinearMessages(cloudJob.id, remainingMessages);
          logger.warn(
            `[runTask] Requeued ${remainingMessages.length} embedded Linear resume message(s) for cloud job ${cloudJob.id} because actor-scoped turn preparation is blocked`,
          );
          return;
        }

        const sent = sendPrompt({
          prompt: text,
          source: 'linear',
          userId: message.userId,
        });

        if (!sent) {
          const remainingMessages = messages.slice(index);
          await prependLinearMessages(cloudJob.id, remainingMessages);
          logger.warn(
            `[runTask] Requeued ${remainingMessages.length} embedded Linear resume message(s) for cloud job ${cloudJob.id} after follow-up delivery failed`,
          );
          return;
        }
      }

      logger.info(
        `[runTask] Delivered ${messages.length} embedded Linear resume message(s) for cloud job ${cloudJob.id}`,
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
      cloudJobId: cloudJob.id,
      cloudJobTaskId: cloudJob.taskId,
      slackReplySatisfactionStateFile:
        mcpTaskEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE,
      codingHarness: harnessType,
      workerEnv,
      allowTerminal: runtimeEnv.ROOMOTE_TASK_TERMINAL === 'true',
      prepareActorScopedTurn,
      validateToken,
    });

    logger.log(
      `[runTask] Sandbox server started on port ${SANDBOX_SERVER_PORT}`,
    );

    await sdk.cloudJobs.update({
      id: cloudJob.id,
      status: CloudTaskStatus.Running,
    });

    // Subscribe to HarnessManager state changes BEFORE starting/resuming a task
    // so we capture the initial stateChange event (which carries sessionId).
    syncPollingState(harnessManager, pollingState, persistRuntimeState);

    logger.info(
      `[runTask] Initial input: promptChars=${initialPrompt.length} imageCount=${images?.length ?? 0} harnessSessionId=${harnessSessionId ?? 'none'}`,
    );

    if (taskCancellation.signal.aborted) {
      logger.info(
        `[runTask] Skipping initial task start for cloud job ${cloudJob.id} because cancellation was requested during startup`,
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
        status: CloudTaskStatus.Canceled,
        error: 'Task aborted',
      };
    } else if (harnessSessionId) {
      const existingResult =
        cloudJob.result &&
        typeof cloudJob.result === 'object' &&
        !Array.isArray(cloudJob.result)
          ? (cloudJob.result as Record<string, unknown>)
          : {};

      const nextResult = {
        ...existingResult,
        runtimeTaskId: harnessSessionId,
      };
      await sdk.cloudJobs.update({ id: cloudJob.id, result: nextResult });
      cloudJob.result = nextResult;
      harnessManager.resumeTask(harnessSessionId);
      await stampRuntimeTaskStartedAt();
      pollingState.sessionId = harnessSessionId;
      pollingState.phase = 'waiting_for_prompt';

      try {
        await callbacks.onStart?.(cloudJob, harnessSessionId, context);
      } catch (error) {
        logger.warn(
          `[runTask] Resume onStart callback failed for cloud job ${cloudJob.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const resumePayload =
        cloudJob.type === CloudTaskType.SnapshotResume &&
        cloudJob.payload &&
        typeof cloudJob.payload === 'object'
          ? (cloudJob.payload as Record<string, unknown>)
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
      });
    } else {
      // Session mode: initialize without prompt.
      harnessManager.initializeWithoutPrompt();
    }

    // Start polling for cancellation and integration events.
    // Polling uses the worker's RunTaskState for interval tracking.
    // (syncPollingState was already called above, before task start/resume.)
    startPolling({
      cloudJob,
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

    // Wait for BullMQ to pick up the authoritative sleep deadline and claim the
    // external sleep action. BullMQ is responsible for both resumable snapshots
    // and non-resumable shutdowns across snapshot-capable providers.
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
    const { claimed: sleepActionTriggered } = skipExternalSleepAction
      ? { claimed: false }
      : await waitForExternalSleepAction({
          cloudJob,
          logger,
        });

    // Fallback: check for pending Linear messages that arrived during the snapshot
    // window. In practice, the provider runtime is torn down during or
    // immediately after snapshot creation, so this code only runs if the
    // snapshot failed/timed out and the worker survived. The primary drain path
    // is in the BullMQ snapshot handler.
    if (
      sleepActionTriggered &&
      (cloudJob.type === CloudTaskType.LinearAgentSession ||
        (cloudJob.type === CloudTaskType.SnapshotResume &&
          !!cloudJob.linearSessionId))
    ) {
      try {
        const result = await sdk.linearSessions.drainLinearMessages({
          cloudJobId: cloudJob.id,
        });

        if (result.resumed) {
          logger.info(
            `[runTask] Created resume cloud job ${result.cloudJobId} for ${result.messageCount} pending Linear message(s) drained from job ${cloudJob.id}`,
          );
        } else {
          logger.info(
            `[runTask] Linear drain check: ${result.reason} (job ${cloudJob.id})`,
          );
        }
      } catch (error) {
        logger.warn(
          `[runTask] Failed to drain Linear messages for job ${cloudJob.id}: ${
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
      (cloudJob.slackThreadTs ||
        getSlackChannelFromTaskPayload(cloudJob.payload))
    ) {
      try {
        const result = await sdk.slackInstallations.drainSlackMessages({
          cloudJobId: cloudJob.id,
        });

        if (result.resumed) {
          logger.info(
            `[runTask] Created resume cloud job ${result.cloudJobId} for ${result.messageCount} pending Slack message(s) drained from job ${cloudJob.id}`,
          );
        } else {
          logger.info(
            `[runTask] Slack drain check: ${result.reason} (job ${cloudJob.id})`,
          );
        }
      } catch (error) {
        logger.warn(
          `[runTask] Failed to drain Slack messages for job ${cloudJob.id}: ${
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
    return resolveStatus(finalState);
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
  cloudJobId: number,
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
      const result = await sdk.cloudJobs.updateRuntimeState({
        id: cloudJobId,
        taskPhase: values.taskPhase,
        sleepAt: values.sleepAt == null ? null : new Date(values.sleepAt),
      });

      if (!result.updated) {
        return;
      }

      void enqueueEvent({
        eventType: 'decision',
        message: `Persisted runtime state for cloud job #${cloudJobId}.`,
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
      message: `Harness ${values.connectionState} for cloud job #${cloudJobId}.`,
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
