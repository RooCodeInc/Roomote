import {
  enqueueTask,
  type FastAutomationExecutionAdapter,
} from '@roomote/cloud-agents/server';
import {
  beginAutomationRunEffect,
  bindAutomationRunDelivery,
  completeAutomationRunEffect,
  db,
  getAutomationRunById,
  getAutomationRunEffect,
  claimAutomationRunChildLink,
  listRetryableAutomationReportDeliveries,
  retryAutomationRunEffect,
  upsertBackgroundAutomationSlackThread,
} from '@roomote/db/server';
import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import { getCommunicationProviderAdapter } from '../lib/communication-providers';
import { buildDestinationTaskPayloadFields } from './destination';

export function createFastAutomationExecutionAdapter(): FastAutomationExecutionAdapter {
  return {
    async postReport(input) {
      const run = await getAutomationRunById(input.automationRunId);
      if (!run?.destination) {
        throw new Error('Automation run has no report destination.');
      }
      const effect = await beginAutomationRunEffect({
        automationRunId: run.id,
        logicalKey: `message:${input.logicalMessageKey}`,
        kind: 'message_delivery',
        requestSignature: input.logicalMessageKey,
        metadata: { message: input.message },
      });
      let activeEffect = effect.effect;
      if (!effect.shouldExecute && effect.effect.status === 'succeeded') return;
      if (!effect.shouldExecute && effect.effect.status === 'failed') {
        const retryClaimed = await retryAutomationRunEffect(effect.effect.id);
        if (!retryClaimed) {
          throw new Error(
            `Automation message ${input.logicalMessageKey} could not be retried.`,
          );
        }
        activeEffect = retryClaimed;
      }
      if (!effect.shouldExecute && effect.inFlight) {
        throw new Error(
          `Automation message ${input.logicalMessageKey} is already in flight.`,
        );
      }

      const adapter = await getCommunicationProviderAdapter(
        run.destination.provider,
      );
      if (!adapter) {
        throw new Error(
          `${run.destination.provider} is not connected for automation delivery.`,
        );
      }

      try {
        const result = await adapter.postMessage({
          channelId: run.destination.channelId,
          ...(run.deliveryThreadId ? { threadId: run.deliveryThreadId } : {}),
          ...(run.destination.serviceUrl
            ? { serviceUrl: run.destination.serviceUrl }
            : {}),
          idempotencyKey: `${run.id}:${input.logicalMessageKey}`,
          text: input.message,
          textFormat: 'markdown',
        });
        const threadId =
          run.deliveryThreadId ?? result.threadId ?? result.messageId;
        await bindAutomationRunDelivery({
          automationRunId: run.id,
          messageId: run.deliveryMessageId ?? result.messageId,
          threadId,
        });
        if (!run.deliveryMessageId && run.automationKey) {
          await upsertBackgroundAutomationSlackThread(db, {
            surface: run.destination.provider,
            automationKey: run.automationKey,
            ...(run.destination.teamId
              ? { slackTeamId: run.destination.teamId }
              : {}),
            slackChannelId: run.destination.channelId,
            threadTs: threadId,
            summaryText: input.message,
            postedAt: new Date(),
            metadata: { automationRunId: run.id },
          });
        }
        await completeAutomationRunEffect({
          id: activeEffect.id,
          attemptToken: activeEffect.attemptToken,
          status: 'succeeded',
          externalId: result.messageId,
          metadata: { message: input.message, result },
        });
      } catch (error) {
        await completeAutomationRunEffect({
          id: activeEffect.id,
          attemptToken: activeEffect.attemptToken,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async launchTask(input) {
      const run = await getAutomationRunById(input.automationRunId);
      if (!run?.automationKey) {
        return {
          success: false,
          error: 'Automation run source was not found.',
        };
      }
      const effect = await beginAutomationRunEffect({
        automationRunId: run.id,
        logicalKey: `child:${input.idempotencyKey}`,
        kind: 'child_launch',
        requestSignature: input.idempotencyKey,
        metadata: { environmentId: input.environmentId, prompt: input.prompt },
      });
      let activeEffect = effect.effect;
      if (!effect.shouldExecute) {
        if (effect.effect.externalId) {
          return { success: true, taskId: effect.effect.externalId };
        }
        if (effect.effect.status === 'failed') {
          const retryClaimed = await retryAutomationRunEffect(effect.effect.id);
          if (!retryClaimed) {
            return {
              success: false,
              error: 'Automation child launch could not be retried.',
            };
          }
          activeEffect = retryClaimed;
        }
        if (effect.inFlight) {
          return {
            success: false,
            error: 'Automation child launch is already in flight.',
          };
        }
      }
      try {
        const launch = await enqueueTask(
          {
            task: {
              type: TaskPayloadKind.StandardTask,
              payload: {
                repo: ALL_REPOSITORIES,
                description: input.prompt,
                ...(input.environmentId &&
                input.environmentId !== ALL_REPOSITORIES
                  ? { environmentId: input.environmentId }
                  : {}),
                backgroundAutomationKey: run.automationKey,
                automationRunParent: {
                  kind: 'automation_run',
                  automationRunId: run.id,
                },
                ...(run.destination
                  ? {
                      ...buildDestinationTaskPayloadFields(run.destination),
                      ...(run.destination.provider === 'slack'
                        ? {
                            channel: run.destination.channelId,
                            slackChannel: run.destination.channelId,
                          }
                        : {}),
                      ...(run.deliveryThreadId
                        ? { communicationThreadId: run.deliveryThreadId }
                        : {}),
                    }
                  : {}),
                ...(input.model
                  ? {
                      harnessModelOverrides: {
                        'opencode-server': input.model,
                      },
                    }
                  : {}),
              },
            },
            initiator: { kind: 'automation', key: run.automationKey },
            workflow: 'standard',
            surface: 'system',
            trigger: run.triggerKind,
            visibility: 'hidden',
          },
          {
            beforeEnqueue: async (taskRun) => {
              const ownsLaunch = await claimAutomationRunChildLink({
                automationRunId: run.id,
                logicalLaunchKey: input.idempotencyKey,
                taskId: taskRun.taskId,
                effectId: activeEffect.id,
                attemptToken: activeEffect.attemptToken,
                metadata: {
                  environmentId: input.environmentId,
                  prompt: input.prompt,
                  taskRunId: taskRun.id,
                },
              });
              if (!ownsLaunch) {
                throw new Error(
                  'Automation child launch lost effect ownership before enqueue.',
                );
              }
            },
          },
        );
        await completeAutomationRunEffect({
          id: activeEffect.id,
          attemptToken: activeEffect.attemptToken,
          status: 'succeeded',
          externalId: launch.taskId,
          metadata: {
            environmentId: input.environmentId,
            prompt: input.prompt,
          },
        });
        return { success: true, taskId: launch.taskId };
      } catch (error) {
        await completeAutomationRunEffect({
          id: activeEffect.id,
          attemptToken: activeEffect.attemptToken,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export async function retryFastAutomationReportDelivery(input: {
  automationRunId: string;
  logicalMessageKey: string;
}): Promise<void> {
  const run = await getAutomationRunById(input.automationRunId);
  const effect = run
    ? await getAutomationRunEffect(run.id, `message:${input.logicalMessageKey}`)
    : null;
  const message = effect?.metadata?.message;
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Automation report delivery payload is unavailable.');
  }
  await createFastAutomationExecutionAdapter().postReport({
    automationRunId: input.automationRunId,
    logicalMessageKey: input.logicalMessageKey,
    message,
  });
}

export async function retryFailedFastAutomationDeliveries(): Promise<void> {
  const deliveries = await listRetryableAutomationReportDeliveries();
  for (const delivery of deliveries) {
    try {
      await retryFastAutomationReportDelivery(delivery);
    } catch (error) {
      console.error(
        `[fast-automation-delivery] Retry failed for ${delivery.automationRunId}/${delivery.logicalMessageKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
