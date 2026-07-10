import type { ResultPromise } from 'execa';

import { type DequeuedCloudJob, sdk } from '@roomote/sdk/client';
import {
  getHarnessModelOverride,
  type EnvironmentMcpServers,
  type LaunchCodingHarness,
} from '@roomote/types';

import { type Harness, startOpenCodeServerHarness } from '../sandbox-server';
import {
  type IntegrationMcpOptions,
  resolveBuiltInMcpServers,
} from '../commands/setup/setup-mcps';
import type { HarnessLogger } from '../logging';

import type { RunTaskCallbacks, RunTaskContext } from './types';
import { buildHarnessCommandEnv } from './harnesses';
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
  cloudJob: DequeuedCloudJob['cloudJob'];
  developerInstructionsContent?: string;
  callbacks: RunTaskCallbacks;
  context: RunTaskContext;
  logger: HarnessLogger;
  prepareQueuedPromptActorScope?: (targetUserId?: string) => Promise<{
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
  cloudJob,
  developerInstructionsContent,
  callbacks,
  context,
  logger,
  prepareQueuedPromptActorScope,
}: CreateHarnessOptions): Promise<CreateHarnessResult> {
  const harnessCommandEnv = buildHarnessCommandEnv(runtimeEnv);
  const stampHarnessStarted = () => {
    // Best-effort: do not derail task startup on telemetry failures.
    void sdk.cloudJobs
      .stampMilestone({
        cloudJobId: cloudJob.id,
        field: 'harnessStartedAt',
      })
      .catch(() => {});
  };

  const spawnHarness = async (options?: {
    initialSessionId?: string;
  }): Promise<{ harness: Harness; subprocess: ResultPromise }> => {
    const resolvedMcps = resolveBuiltInMcpServers(
      mcpTaskEnv,
      integrations,
      environmentMcpServers,
    );
    const modelOverride = cloudJob.payload?.harnessModelOverrides
      ? getHarnessModelOverride(
          cloudJob.payload.harnessModelOverrides,
          harnessType,
        )
      : undefined;

    const commonOptions = {
      workspacePath,
      runtimeEnv: harnessCommandEnv,
      cancelSignal,
      logger,
      mcpServers: resolvedMcps,
      initialSessionId: options?.initialSessionId ?? harnessSessionId,
      beforeQueuedPrompt: prepareQueuedPromptActorScope
        ? async ({ userId }: { userId?: string }) =>
            await prepareQueuedPromptActorScope(userId)
        : undefined,
      ...(modelOverride ? { modelOverride } : {}),
    };

    return await startOpenCodeServerHarness({
      ...commonOptions,
      developerInstructionsContent,
    });
  };

  const reconnectableHarness = new ReconnectableHarness({
    logger,
    spawnHarness,
  });
  await reconnectableHarness.start({ initialSessionId: harnessSessionId });
  stampHarnessStarted();

  const unsubscribe = subscribeHarnessCallbacks({
    harness: reconnectableHarness,
    cloudJob,
    callbacks,
    context,
    logger,
  });

  return {
    harness: reconnectableHarness,
    getSubprocess: () => reconnectableHarness.getCurrentSubprocess(),
    unsubscribe,
  };
}
