import { z } from 'zod';

import {
  completeAutomationRun,
  countAutomationRunChildren,
  getActiveAutomationRunForPrincipal,
  getDeploymentTaskModelOptions,
  recordAutomationRunUsage,
  renewAutomationRunLease,
  suspendAutomationRunForChildren,
} from '@roomote/db/server';
import {
  fastAutomationExecutionPolicySchema,
  formatErrorForLog,
  type TaskModelOption,
} from '@roomote/types';

import {
  generateTrackedNonTaskTextInOpenCodeSession,
  NON_TASK_INFERENCE_SURFACES,
} from '../non-task-provider-usage';
import { getAvailableEnvironments } from '../router';
import { FAST_AGENT_MODEL_ROLE } from './fast-agent-constants';
import {
  callFastAgentIntegration,
  listFastAgentIntegrations,
} from './fast-agent-integration-broker';
import {
  bindFastAgentNativeToolExecutor,
  FAST_AGENT_NATIVE_TOOL_NAMES,
  FAST_AUTOMATION_NATIVE_TOOL_FILTER,
  getFastAgentNativeToolRuntime,
  type FastAgentNativeToolCall,
} from './fast-agent-native-tool-bridge';
import { fastAgentOpenCodeSessionManager } from './fast-agent-opencode-session';
import { buildFastAutomationSystemPrompt } from './fast-automation-prompt';

const integrationCallArgsSchema = z.object({
  integrationId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.unknown()),
});
const reportArgsSchema = z.object({
  message: z.string().trim().min(1),
  purpose: z.enum(['ack', 'progress', 'closeout', 'clarification']),
  logicalMessageKey: z.string().trim().min(1),
});
const launchArgsSchema = z.object({
  prompt: z.string().trim().min(1),
  environmentId: z.string().trim().min(1).nullable().optional(),
  model: z.string().trim().min(1).nullable().optional(),
  idempotencyKey: z.string().trim().min(1),
});
const completeArgsSchema = z.object({
  outcome: z.enum(['succeeded', 'skipped', 'failed']),
  summary: z.string().max(10_000).optional(),
});

export type FastAutomationExecutionAdapter = {
  postReport(input: {
    automationRunId: string;
    logicalMessageKey: string;
    message: string;
  }): Promise<void>;
  launchTask(input: {
    automationRunId: string;
    idempotencyKey: string;
    prompt: string;
    environmentId: string | null;
    model: string | null;
  }): Promise<
    | { success: true; taskId: string; taskUrl?: string }
    | { success: false; error: string }
  >;
};

export async function runFastAutomationExecution(input: {
  automationRunId: string;
  leaseOwner: string;
  policyVersion: number;
  apiBaseUrl?: string;
  adapter: FastAutomationExecutionAdapter;
  prompt?: string;
  continuation?: boolean;
}): Promise<{
  status: 'succeeded' | 'skipped' | 'failed' | 'waiting_for_children';
  summary?: string;
}> {
  const run = await getActiveAutomationRunForPrincipal({
    automationRunId: input.automationRunId,
    leaseOwner: input.leaseOwner,
    policyVersion: input.policyVersion,
  });
  if (!run) throw new Error('Automation run lease is no longer active.');

  const policy = fastAutomationExecutionPolicySchema.parse(run.policySnapshot);
  const brokerContext = {
    automationRunId: run.id,
    automationLeaseOwner: input.leaseOwner,
    automationPolicyVersion: policy.version,
    apiBaseUrl: input.apiBaseUrl,
  };
  let availableEnvironments: Awaited<
    ReturnType<typeof getAvailableEnvironments>
  >;
  let taskModels: { models: TaskModelOption[]; defaultModelId?: string };
  let availableIntegrations: Awaited<
    ReturnType<typeof listFastAgentIntegrations>
  >;
  let system: string;
  try {
    [availableEnvironments, taskModels, availableIntegrations] =
      await Promise.all([
        getAvailableEnvironments(),
        getDeploymentTaskModelOptions().catch(() => ({
          models: [],
          defaultModelId: undefined,
        })),
        listFastAgentIntegrations(brokerContext),
      ]);
    system = buildFastAutomationSystemPrompt({
      automationKey: run.automationKey ?? run.sourceKey,
      policy,
      availableEnvironments,
      availableTaskModels: taskModels.models,
      availableIntegrations,
    });
  } catch (error) {
    await completeAutomationRun({
      automationRunId: run.id,
      leaseOwner: input.leaseOwner,
      status: 'failed',
      error: formatErrorForLog(error).slice(0, 10_000),
    });
    throw error;
  }
  const validEnvironmentIds = new Set(
    availableEnvironments.map((environment) => environment.id),
  );
  let terminal:
    | {
        status: 'succeeded' | 'skipped' | 'failed' | 'waiting_for_children';
        summary?: string;
      }
    | undefined;
  let reportCount = 0;
  let orchestrationSessionId: string | null = null;
  const abortController = new AbortController();
  const leaseHeartbeat = setInterval(() => {
    void renewAutomationRunLease({
      automationRunId: run.id,
      leaseOwner: input.leaseOwner,
      leaseDurationMs: 15 * 60_000,
    })
      .then((renewed) => {
        if (!renewed) {
          abortController.abort(new Error('Automation run lease was lost.'));
        }
      })
      .catch((error: unknown) => abortController.abort(error));
  }, 60_000);
  leaseHeartbeat.unref?.();

  const executeNativeTool = async (call: FastAgentNativeToolCall) => {
    if (terminal) {
      return { success: false, error: 'This automation run is complete.' };
    }

    switch (call.name) {
      case FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall: {
        const args = integrationCallArgsSchema.parse(call.args);
        const result = await callFastAgentIntegration(
          brokerContext,
          availableIntegrations,
          {
            integrationId: args.integrationId,
            toolName: args.toolName,
            args: args.arguments,
          },
        );
        return { success: true, result };
      }
      case FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply: {
        const args = reportArgsSchema.parse(call.args);
        if (args.purpose === 'ack' || args.purpose === 'progress') {
          return {
            success: false,
            error: 'Automation runs may only post final reports or blockers.',
          };
        }
        await input.adapter.postReport({
          automationRunId: run.id,
          logicalMessageKey: args.logicalMessageKey,
          message: args.message,
        });
        reportCount += 1;
        return { success: true, delivered: true };
      }
      case FAST_AGENT_NATIVE_TOOL_NAMES.launchTask: {
        const args = launchArgsSchema.parse(call.args);
        if (input.continuation) {
          return {
            success: false,
            error: 'Automation continuation turns cannot launch child tasks.',
          };
        }
        if (policy.maxChildTasks === 0) {
          return {
            success: false,
            error: 'Child task launches are disabled for this automation.',
          };
        }
        if (
          args.environmentId &&
          !validEnvironmentIds.has(args.environmentId)
        ) {
          return {
            success: false,
            error: 'The selected environment was not found.',
          };
        }
        if (
          !args.environmentId ||
          !policy.allowedEnvironmentIds.includes(args.environmentId)
        ) {
          return {
            success: false,
            error:
              'The selected environment is outside this automation run scope.',
          };
        }
        if (
          args.model &&
          !taskModels.models.some((model) => model.id === args.model)
        ) {
          return {
            success: false,
            error: 'The selected model is not enabled.',
          };
        }
        return input.adapter.launchTask({
          automationRunId: run.id,
          idempotencyKey: args.idempotencyKey,
          prompt: args.prompt,
          environmentId: args.environmentId ?? null,
          model: args.model ?? null,
        });
      }
      case FAST_AGENT_NATIVE_TOOL_NAMES.completeAutomationRun: {
        const args = completeArgsSchema.parse(call.args);
        if (
          args.outcome !== 'failed' &&
          policy.reporting === 'required' &&
          reportCount === 0
        ) {
          return {
            success: false,
            error: 'This automation requires a report before completion.',
          };
        }
        const childCount = await countAutomationRunChildren(run.id);
        const waitingForChildren =
          !input.continuation && args.outcome === 'succeeded' && childCount > 0;
        const completed = waitingForChildren
          ? await suspendAutomationRunForChildren({
              automationRunId: run.id,
              leaseOwner: input.leaseOwner,
            })
          : await completeAutomationRun({
              automationRunId: run.id,
              leaseOwner: input.leaseOwner,
              status: args.outcome,
              error: args.outcome === 'failed' ? args.summary : null,
              orchestrationSessionId,
            });
        if (!completed) {
          return {
            success: false,
            error: 'Automation run completion lost its lease.',
          };
        }
        terminal = {
          status: waitingForChildren ? 'waiting_for_children' : args.outcome,
          ...(args.summary ? { summary: args.summary } : {}),
        };
        return { success: true, closed: true };
      }
      default:
        return {
          success: false,
          error: 'That native tool is unavailable to automation runs.',
        };
    }
  };

  try {
    const nativeRuntime = await getFastAgentNativeToolRuntime();
    await fastAgentOpenCodeSessionManager.run({
      conversationId: `automation:${run.id}`,
      prompt: input.prompt ?? run.promptSnapshot,
      bootstrapPrompt: input.prompt ?? run.promptSnapshot,
      execute: async (session, prompt) => {
        let unbind: (() => void) | undefined;
        try {
          return await generateTrackedNonTaskTextInOpenCodeSession(
            {
              userId: null,
              surface: NON_TASK_INFERENCE_SURFACES.fastAutomation,
              modelRole: FAST_AGENT_MODEL_ROLE,
              timeoutMs: null,
              system,
              prompt,
              onUsageRecorded: (usage) =>
                recordAutomationRunUsage({
                  automationRunId: run.id,
                  ...usage,
                }),
            },
            session,
            {
              directory: nativeRuntime.directory,
              env: nativeRuntime.env,
              signal: abortController.signal,
              tools: FAST_AUTOMATION_NATIVE_TOOL_FILTER,
              onSessionReady: (sessionId) => {
                orchestrationSessionId = sessionId;
                unbind?.();
                unbind = bindFastAgentNativeToolExecutor(
                  sessionId,
                  executeNativeTool,
                );
              },
            },
          );
        } finally {
          unbind?.();
        }
      },
    });
  } catch (error) {
    if (terminal) return terminal;
    await completeAutomationRun({
      automationRunId: run.id,
      leaseOwner: input.leaseOwner,
      status: 'failed',
      error: formatErrorForLog(error).slice(0, 10_000),
      orchestrationSessionId,
    });
    throw error;
  } finally {
    clearInterval(leaseHeartbeat);
  }

  if (!terminal) {
    await completeAutomationRun({
      automationRunId: run.id,
      leaseOwner: input.leaseOwner,
      status: 'failed',
      error: 'Automation inference ended without a terminal operation.',
      orchestrationSessionId,
    });
    throw new Error('Automation inference ended without a terminal operation.');
  }

  return terminal;
}
