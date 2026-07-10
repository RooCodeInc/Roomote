import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { resolveSingleSourceControlProvider } from '@/lib/server/source-control-provider';
import { buildSetupKickoffText } from '@roomote/communication/chat-messages';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { SlackNotifier } from '@roomote/slack';
import {
  db,
  taskRuns,
  eq,
  inArray,
  sql,
  markTaskStartParallelCountEndedAt,
} from '@roomote/db/server';
import { recordSlackConversationMessageBestEffort } from '@roomote/sdk/server';
import {
  CloudTaskStatus,
  TaskPayloadKind,
  resolveEvalHarnessSelection,
  isExitedCloudTaskStatus,
  normalizeSetupNewState,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import {
  appendEnvironmentDefinitionGuidance,
  buildSetupNewKickoffPrompt,
  buildSetupNewWorkspacePayload,
} from '@/lib/setup-new';

import { assertAdmin, ensureDefaultSetupAgents } from '../setup/shared';
import { triggerTaskSuggestionsCommand } from '../task-suggestions';
import {
  assertHasCommittedRepositorySelection,
  assertSetupQualificationNotBlocked,
  clearQueuedSetupTasks,
  clearTaskSuggestions,
  didSuggestionSourceChange,
  getPersistedSetupNewState,
  resolveSelectedRepositories,
  savePersistedSetupNewState,
} from './shared';
import {
  resolveSetupChatFallbackHandoffTarget,
  resolveSetupSlackHandoffTarget,
} from './handoff';

export async function saveSetupNewSelectionCommand(
  auth: UserAuthSuccess,
  input: {
    repositoryIds: string[];
    setupGuidance?: string;
    selectedModelId?: string;
  },
) {
  assertAdmin(auth);
  await assertSetupQualificationNotBlocked(auth);

  const { userId } = auth;

  if (input.repositoryIds.length === 0) {
    throw new Error('Select at least one repository to continue.');
  }

  const { normalizedRepositoryIds } = await resolveSelectedRepositories(
    input.repositoryIds,
  );
  await assertHasCommittedRepositorySelection(normalizedRepositoryIds);
  const nextSetupGuidance = input.setupGuidance?.trim() || null;
  const nextSelectedModelId = input.selectedModelId?.trim() || null;

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      selectedRepositoryIds: normalizedRepositoryIds,
      setupGuidance: nextSetupGuidance,
      selectedModelId: nextSelectedModelId,
      onboardingTaskId: null,
      onboardingTaskStartedAt: null,
      slackTeamId: null,
      slackChannel: null,
      slackThreadTs: null,
      chatHandoffProvider: null,
      chatHandoffChannelId: null,
      chatHandoffThreadId: null,
      chatHandoffServiceUrl: null,
      suggestionTaskId: null,
      suggestionTaskStartedAt: null,
      suggestionGenerationTriggeredAt: null,
      lastInteractedByUserId: userId,
    });

    await savePersistedSetupNewState(setupNewState, tx);
    await clearQueuedSetupTasks(tx);

    if (
      didSuggestionSourceChange({
        currentState,
        nextRepositoryIds: normalizedRepositoryIds,
        nextSetupGuidance,
      })
    ) {
      await clearTaskSuggestions(currentState.suggestionTaskId, tx);
    }

    return {
      setupNewState,
    };
  });
}

export async function startSetupNewOnboardingTaskCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  await assertSetupQualificationNotBlocked(auth);

  const { userId } = auth;
  const startResult = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('setup-new'))`);

    const currentState = await getPersistedSetupNewState(tx);

    if (currentState.onboardingTaskId) {
      return {
        taskId: currentState.onboardingTaskId,
        startedAt: currentState.onboardingTaskStartedAt,
        launchedNewOnboardingTask: false as const,
      };
    }

    const { normalizedRepositoryIds, selectedRepositories } =
      await resolveSelectedRepositories(currentState.selectedRepositoryIds);
    await assertHasCommittedRepositorySelection(normalizedRepositoryIds);

    if (selectedRepositories.length === 0) {
      throw new Error('Select at least one repository before starting setup.');
    }

    const selectedRepositoryFullNames = selectedRepositories.map(
      (repository) => repository.fullName,
    );
    const workspacePayload = buildSetupNewWorkspacePayload(
      selectedRepositoryFullNames,
    );
    // Stamp the provider explicitly: dequeue defaults to GitHub when the
    // payload omits it, which breaks non-GitHub deployments.
    const setupSourceControlProvider = resolveSingleSourceControlProvider(
      selectedRepositories.map(
        (repository) => repository.sourceControlProvider,
      ),
    );
    const prompt = appendEnvironmentDefinitionGuidance(
      buildSetupNewKickoffPrompt(selectedRepositoryFullNames),
      currentState.setupGuidance,
    );
    const modelSelection = resolveEvalHarnessSelection({
      model: currentState.selectedModelId ?? undefined,
    });

    if (!modelSelection.ok) {
      throw new Error(modelSelection.error);
    }

    const handoffTarget = await resolveSetupSlackHandoffTarget(
      {
        userId,
      },
      tx,
    );

    if (!handoffTarget) {
      // No connected Slack workspace (or the admin never linked their Slack
      // account). Fall back to the next chat surface (Telegram, then Teams)
      // so the kickoff still gets a real conversation thread; only when no
      // chat surface exists does onboarding run as a web-only task whose
      // progress stays visible in the setup wizard's task panel.
      const fallbackTarget = await resolveSetupChatFallbackHandoffTarget();

      if (fallbackTarget) {
        const kickoffMessage = buildSetupKickoffText();
        let kickoffMessageId: string | null = null;
        let kickoffChannelId: string | null = null;

        if (fallbackTarget.provider === 'telegram') {
          const telegram = new TelegramCommunicationProvider({
            botToken: fallbackTarget.botToken,
          });
          const posted = await telegram.postMessage({
            channelId: fallbackTarget.chatId,
            text: kickoffMessage,
            textFormat: 'markdown',
          });

          if (!posted.messageId) {
            throw new Error(
              'Roomote could not post the Telegram setup kickoff.',
            );
          }

          kickoffMessageId = posted.messageId;
          kickoffChannelId = fallbackTarget.chatId;
        } else {
          // Teams is best-effort: when the kickoff post fails, onboarding
          // continues as a web-only task instead of failing setup, and the
          // persisted handoff fields stay null so Teams never looks
          // connected without a delivered kickoff.
          try {
            const posted = await fallbackTarget.teams.postMessage({
              channelId: fallbackTarget.conversationId,
              serviceUrl: fallbackTarget.serviceUrl,
              text: kickoffMessage,
              textFormat: 'markdown',
            });

            if (posted.messageId) {
              kickoffMessageId = posted.messageId;
              kickoffChannelId = fallbackTarget.conversationId;
            } else {
              console.warn(
                '[setup-new] The Teams setup kickoff post returned no message id; onboarding continues as a web-only task.',
              );
            }
          } catch (error) {
            console.warn(
              '[setup-new] Failed to post the Teams setup kickoff; onboarding continues as a web-only task.',
              error,
            );
          }
        }

        if (kickoffMessageId && kickoffChannelId) {
          const startedAt = new Date().toISOString();
          const launchResult = await enqueueCloudTask({
            task: {
              ...(modelSelection.harness
                ? { harness: modelSelection.harness }
                : {}),
              type: TaskPayloadKind.StandardTask,
              payload: {
                ...workspacePayload,
                ...(setupSourceControlProvider
                  ? { sourceControlProvider: setupSourceControlProvider }
                  : {}),
                description: prompt,
                visibleInTranscript: false,
                communicationProvider: fallbackTarget.provider,
                communicationChannelId: kickoffChannelId,
                communicationMessageId: kickoffMessageId,
                ...(fallbackTarget.provider === 'teams'
                  ? {
                      communicationThreadId: kickoffMessageId,
                      communicationServiceUrl: fallbackTarget.serviceUrl,
                    }
                  : {}),
                ...(modelSelection.harnessModelOverrides
                  ? {
                      harnessModelOverrides:
                        modelSelection.harnessModelOverrides,
                    }
                  : {}),
              },
            },
            initiator: { kind: 'user', userId },
            workflow: 'setup_onboarding',
            surface: 'web',
            trigger: 'manual',
          });

          await savePersistedSetupNewState(
            normalizeSetupNewState({
              ...currentState,
              selectedRepositoryIds: normalizedRepositoryIds,
              setupGuidance: currentState.setupGuidance ?? null,
              onboardingTaskId: launchResult.taskId,
              onboardingTaskStartedAt: startedAt,
              slackTeamId: null,
              slackChannel: null,
              slackThreadTs: null,
              chatHandoffProvider: fallbackTarget.provider,
              chatHandoffChannelId: kickoffChannelId,
              chatHandoffThreadId: kickoffMessageId,
              chatHandoffServiceUrl:
                fallbackTarget.provider === 'teams'
                  ? fallbackTarget.serviceUrl
                  : null,
              lastInteractedByUserId: userId,
            }),
            tx,
          );

          return {
            taskId: launchResult.taskId,
            startedAt,
            launchedNewOnboardingTask: true as const,
          };
        }
      }

      const startedAt = new Date().toISOString();
      const launchResult = await enqueueCloudTask({
        task: {
          ...(modelSelection.harness
            ? { harness: modelSelection.harness }
            : {}),
          type: TaskPayloadKind.StandardTask,
          payload: {
            ...workspacePayload,
            ...(setupSourceControlProvider
              ? { sourceControlProvider: setupSourceControlProvider }
              : {}),
            description: prompt,
            visibleInTranscript: false,
            ...(modelSelection.harnessModelOverrides
              ? {
                  harnessModelOverrides: modelSelection.harnessModelOverrides,
                }
              : {}),
          },
        },
        initiator: { kind: 'user', userId },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      });

      await savePersistedSetupNewState(
        normalizeSetupNewState({
          ...currentState,
          selectedRepositoryIds: normalizedRepositoryIds,
          setupGuidance: currentState.setupGuidance ?? null,
          onboardingTaskId: launchResult.taskId,
          onboardingTaskStartedAt: startedAt,
          slackTeamId: null,
          slackChannel: null,
          slackThreadTs: null,
          chatHandoffProvider: null,
          chatHandoffChannelId: null,
          chatHandoffThreadId: null,
          chatHandoffServiceUrl: null,
          lastInteractedByUserId: userId,
        }),
        tx,
      );

      return {
        taskId: launchResult.taskId,
        startedAt,
        launchedNewOnboardingTask: true as const,
      };
    }

    const slack = new SlackNotifier(handoffTarget.botAccessToken);
    const slackChannel = await slack.openConversation(
      handoffTarget.slackUserId,
    );

    if (!slackChannel) {
      throw new Error('Roomote could not open a Slack DM for setup.');
    }

    const kickoffMessage = buildSetupKickoffText({
      userMention: `<@${handoffTarget.slackUserId}>`,
    });
    const slackThreadTs = await slack.postMessage({
      channel: slackChannel,
      text: kickoffMessage,
    });

    if (!slackThreadTs) {
      throw new Error('Roomote could not post the Slack setup kickoff.');
    }

    const startedAt = new Date().toISOString();
    let launchResult: Awaited<ReturnType<typeof enqueueCloudTask>>;

    try {
      launchResult = await enqueueCloudTask({
        task: {
          ...(modelSelection.harness
            ? { harness: modelSelection.harness }
            : {}),
          type: TaskPayloadKind.SlackAppMention,
          payload: {
            ...workspacePayload,
            ...(setupSourceControlProvider
              ? { sourceControlProvider: setupSourceControlProvider }
              : {}),
            channel: slackChannel,
            user: handoffTarget.slackUserId,
            text: prompt,
            ts: slackThreadTs,
            thread_ts: slackThreadTs,
            webPath: '/setup',
            visibleInTranscript: false,
            ...(modelSelection.harnessModelOverrides
              ? {
                  harnessModelOverrides: modelSelection.harnessModelOverrides,
                }
              : {}),
          },
        },
        initiator: { kind: 'user', userId },
        workflow: 'setup_onboarding',
        surface: 'slack',
        trigger: 'manual',
        channels: {
          slackChannelId: slackChannel,
          slackThreadTs,
        },
      });
    } catch (error) {
      await slack.deleteMessage({ channel: slackChannel, ts: slackThreadTs });
      throw error;
    }

    await savePersistedSetupNewState(
      normalizeSetupNewState({
        ...currentState,
        selectedRepositoryIds: normalizedRepositoryIds,
        setupGuidance: currentState.setupGuidance ?? null,
        onboardingTaskId: launchResult.taskId,
        onboardingTaskStartedAt: startedAt,
        slackTeamId: handoffTarget.slackTeamId,
        slackChannel,
        slackThreadTs,
        chatHandoffProvider: 'slack',
        chatHandoffChannelId: slackChannel,
        chatHandoffThreadId: slackThreadTs,
        chatHandoffServiceUrl: null,
        lastInteractedByUserId: userId,
      }),
      tx,
    );

    await recordSlackConversationMessageBestEffort({
      logContext: 'setupNew.startOnboardingTask',
      subjectUserId: userId,
      slackTeamId: handoffTarget.slackTeamId,
      subjectSlackUserId: handoffTarget.slackUserId,
      slackChannelId: slackChannel,
      conversationKind: 'dm',
      messageTs: slackThreadTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: 'setup_dm',
      text: kickoffMessage,
      taskId: launchResult.taskId,
      cloudJobId: launchResult.id,
    });

    return {
      taskId: launchResult.taskId,
      startedAt,
      launchedNewOnboardingTask: true as const,
    };
  });

  try {
    await triggerTaskSuggestionsCommand(auth);
  } catch (error) {
    console.error(
      `[startSetupNewOnboardingTaskCommand] Failed to trigger task suggestions: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    taskId: startResult.taskId,
    startedAt: startResult.startedAt,
  };
}

export async function cancelSetupNewOnboardingTaskCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);

  const currentState = await getPersistedSetupNewState();

  if (!currentState.onboardingTaskId) {
    return { success: true as const };
  }

  const jobs = await db
    .select({
      id: taskRuns.id,
      status: taskRuns.status,
    })
    .from(taskRuns)
    .where(eq(taskRuns.taskId, currentState.onboardingTaskId));

  const activeJobIds = jobs
    .filter((job) => !isExitedCloudTaskStatus(job.status))
    .map((job) => job.id);

  if (activeJobIds.length > 0) {
    const endedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(taskRuns)
        .set({
          status: CloudTaskStatus.Canceled,
          canceledAt: endedAt,
        })
        .where(inArray(taskRuns.id, activeJobIds));

      await Promise.all(
        activeJobIds.map((runId) =>
          markTaskStartParallelCountEndedAt(tx, {
            runId,
            endedAt,
          }),
        ),
      );
    });
  }

  return { success: true as const };
}

export async function resetSetupNewSelectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const { userId } = auth;

  return db.transaction(async (tx) => {
    const currentState = await getPersistedSetupNewState(tx);
    const setupNewState = normalizeSetupNewState({
      ...currentState,
      selectedRepositoryIds: [],
      setupGuidance: null,
      onboardingTaskId: null,
      onboardingTaskStartedAt: null,
      slackTeamId: null,
      slackChannel: null,
      slackThreadTs: null,
      chatHandoffProvider: null,
      chatHandoffChannelId: null,
      chatHandoffThreadId: null,
      chatHandoffServiceUrl: null,
      suggestionTaskId: null,
      suggestionTaskStartedAt: null,
      suggestionGenerationTriggeredAt: null,
      lastInteractedByUserId: userId,
    });

    await savePersistedSetupNewState(setupNewState, tx);
    await clearTaskSuggestions(currentState.suggestionTaskId, tx);
    await clearQueuedSetupTasks(tx);

    return {
      setupNewState,
    };
  });
}

export async function ensureSetupNewDefaultAgentsCommand(
  auth: UserAuthSuccess,
) {
  return ensureDefaultSetupAgents(auth);
}
