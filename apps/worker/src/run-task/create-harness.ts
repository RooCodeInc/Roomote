import type { ResultPromise } from 'execa';

import { type DequeuedTaskRun, sdk } from '@roomote/sdk/client';
import {
  buildTaskModelRoleOverrideEnv,
  getHarnessModelOverride,
  isReasoningEffort,
  type EnvironmentMcpServers,
  type LaunchCodingHarness,
} from '@roomote/types';

import { type Harness, startOpenCodeServerHarness } from '../sandbox-server';
import {
  type IntegrationMcpOptions,
  resolveBuiltInMcpServers,
} from '../commands/setup/setup-mcps';
import type { HarnessLogger } from '../logging';

import { captureWorkerException } from '../monitoring/sentry';

import type { RunTaskCallbacks, RunTaskContext } from './types';
import { buildHarnessCommandEnv } from './harnesses';
import { createDiagnosticEventRecorder } from './diagnostic-events';
import { OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME } from './opencode-tool-safety-plugin-script';
import { ReconnectableHarness } from './reconnectable-harness';
import { subscribeHarnessCallbacks } from './subscribe-harness-callbacks';

interface CreateHarnessOptions {
  harnessType: LaunchCodingHarness;
  workspacePath: string;
  runtimeEnv: Record<string, string>;
  harnessSessionId: string | undefined;
  cancelSignal: AbortSignal;
  integrations: IntegrationMcpOptions;
  mcpTaskEnv: Record<string, string>;
  environmentMcpServers?: EnvironmentMcpServers;
  /**
   * Deployment-scoped custom stdio MCP servers, fetched once at task start.
   * Merged after environment servers, so an environment entry with the same
   * name wins.
   */
  deploymentMcpServers?: EnvironmentMcpServers;
  /**
   * Operator-defined deployment env vars. Always eligible for ${...}
   * substitution in custom MCP config, regardless of variable name.
   */
  operatorEnvVars?: Record<string, string>;
  taskRun: DequeuedTaskRun['taskRun'];
  developerInstructionsContent?: string;
  callbacks: RunTaskCallbacks;
  context: RunTaskContext;
  logger: HarnessLogger;
  prepareQueuedPromptActorScope?: (
    targetUserId?: string,
    delivery?: {
      kind: 'queuedPrompt' | 'userInputAnswer';
      clientMessageId?: string;
    },
  ) => Promise<{
    shouldReconnect: boolean;
    shouldBlockPrompt?: boolean;
    shouldSkipPrompt?: boolean;
    reason?: string;
  }>;
}

interface CreateHarnessResult {
  harness: Harness;
  getSubprocess: () => ResultPromise | null;
  /** Unsubscribe from message/envelope event subscriptions. */
  unsubscribe: () => Promise<void>;
  /** Deliver the turn's closing assistant message before idle settlement. */
  flushPendingCompletionEvents: () => Promise<void>;
}

export async function createHarness({
  harnessType,
  workspacePath,
  runtimeEnv,
  harnessSessionId,
  cancelSignal,
  integrations,
  mcpTaskEnv,
  environmentMcpServers,
  deploymentMcpServers,
  operatorEnvVars,
  taskRun,
  developerInstructionsContent,
  callbacks,
  context,
  logger,
  prepareQueuedPromptActorScope,
}: CreateHarnessOptions): Promise<CreateHarnessResult> {
  const harnessCommandEnv = buildHarnessCommandEnv(runtimeEnv);
  const stampHarnessStarted = () => {
    // Best-effort: do not derail task startup on telemetry failures.
    void sdk.taskRuns
      .stampMilestone({
        runId: taskRun.id,
        field: 'harnessStartedAt',
      })
      .catch(() => {});
  };

  const diagnosticEvents = createDiagnosticEventRecorder({
    runId: taskRun.id,
    logger,
  });

  const spawnHarness = async (options?: {
    initialSessionId?: string;
  }): Promise<{ harness: Harness; subprocess: ResultPromise }> => {
    const resolvedMcps = resolveBuiltInMcpServers(
      mcpTaskEnv,
      integrations,
      environmentMcpServers,
      operatorEnvVars,
      deploymentMcpServers,
    );
    const modelOverride = taskRun.payload?.harnessModelOverrides
      ? getHarnessModelOverride(
          taskRun.payload.harnessModelOverrides,
          harnessType,
        )
      : undefined;
    // Per-task reasoning effort stamped at launch (or set explicitly via the
    // public API). Applied to the effective coding model, which per-role env
    // levels do not cover when a launch-time model override is in play.
    const reasoningEffortOverride = isReasoningEffort(
      taskRun.payload?.reasoningEffort,
    )
      ? taskRun.payload.reasoningEffort
      : undefined;
    // Read at every spawn (not just the first) so a config-update restart
    // regenerates the OpenCode config from the task's current overrides.
    const modelRoleOverrideEnv = buildTaskModelRoleOverrideEnv(
      taskRun.payload?.modelRoleOverrides,
    );
    const spawnRuntimeEnv =
      Object.keys(modelRoleOverrideEnv).length > 0
        ? { ...harnessCommandEnv, ...modelRoleOverrideEnv }
        : harnessCommandEnv;
    const redactedEnvNames = Object.keys(operatorEnvVars ?? {}).sort();
    const openCodeRuntimeEnv =
      redactedEnvNames.length > 0
        ? {
            ...spawnRuntimeEnv,
            [OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME]:
              JSON.stringify(redactedEnvNames),
          }
        : spawnRuntimeEnv;

    const commonOptions = {
      workspacePath,
      runtimeEnv: openCodeRuntimeEnv,
      cancelSignal,
      logger,
      mcpServers: resolvedMcps,
      initialSessionId: options?.initialSessionId ?? harnessSessionId,
      beforeQueuedPrompt: prepareQueuedPromptActorScope
        ? async ({
            userId,
            clientMessageId,
            kind,
          }: {
            userId?: string;
            clientMessageId?: string;
            kind: 'queuedPrompt' | 'userInputAnswer';
          }) =>
            await prepareQueuedPromptActorScope(userId, {
              kind,
              clientMessageId,
            })
        : undefined,
      ...(modelOverride ? { modelOverride } : {}),
      ...(reasoningEffortOverride ? { reasoningEffortOverride } : {}),
    };

    return await startOpenCodeServerHarness({
      ...commonOptions,
      developerInstructionsContent,
      onDiagnostic: (input) => {
        diagnosticEvents.record(input);
      },
      onUnexpectedExit: (certificate) => {
        const summary = `OpenCode server exited unexpectedly (code=${
          certificate.exitCode ?? 'none'
        }, signal=${certificate.signal ?? 'none'}) after ${Math.round(
          certificate.uptimeMs / 1000,
        )}s`;

        diagnosticEvents.record({
          kind: 'opencode_unexpected_exit',
          message: summary,
          details: {
            exitCode: certificate.exitCode,
            signal: certificate.signal,
            uptimeMs: certificate.uptimeMs,
            memoryAfterExit: certificate.memoryAfterExit,
            outputTail: certificate.outputTail,
          },
        });
        captureWorkerException(new Error(summary), {
          runId: taskRun.id,
          taskId: taskRun.taskId ?? undefined,
          component: 'createHarness',
          stage: 'opencode_unexpected_exit',
          exitCode: certificate.exitCode,
          signal: certificate.signal,
          uptimeMs: certificate.uptimeMs,
        });
      },
    });
  };

  const reconnectableHarness = new ReconnectableHarness({
    logger,
    spawnHarness,
    diagnosticEvents,
  });
  await reconnectableHarness.start({ initialSessionId: harnessSessionId });
  stampHarnessStarted();

  const unsubscribe = subscribeHarnessCallbacks({
    harness: reconnectableHarness,
    taskRun,
    callbacks,
    context,
    logger,
    mcpTaskEnv,
  });

  return {
    harness: reconnectableHarness,
    getSubprocess: () => reconnectableHarness.getCurrentSubprocess(),
    unsubscribe,
    flushPendingCompletionEvents: unsubscribe.flushPendingCompletionEvents,
  };
}
