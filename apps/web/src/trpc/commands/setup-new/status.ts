import {
  purgeSavedDeploymentWorkerImage,
  isChatGptSubscriptionConnected,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';
import {
  buildSetupAuthStatus,
  buildSetupComputeStatus,
  buildSetupModelStatus,
  buildSetupSourceControlStatus,
  hasSetupChatHandoffDestination,
  normalizeSetupNewState,
  presentSetupNewComputeProvisioning,
  NON_SECRET_COMPUTE_ENV_VAR_NAMES,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { getSourceControlConnectionSummary } from '@/lib/server';
import {
  isSetupNewOnboardingFailureStatus,
  isSetupNewOnboardingSuccessStatus,
  isSetupNewOnboardingTerminalSuccessStatus,
} from '@/lib/setup-new';

import { assertAdmin, getSetupBaseStatus } from '../setup/shared';
import {
  getPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues,
} from '../environment-variables';
import { getPersistedRuntimeComputeConfig } from '../compute';
import { triggerTaskSuggestionsCommand } from '../task-suggestions';
import {
  getActiveSetupQualificationBlock,
  getMatchingEnvironmentSummary,
  getOnboardingTaskState,
  getPersistedRuntimeModelConfig,
  getPersistedSetupNewState,
  resolveSelectedRepositories,
  type SelectedRepositorySummary,
} from './shared';
import { getSetupSlackAccessStatus } from './handoff';
import {
  getPersistedQueuedSetupTasks,
  launchQueuedSetupTasksIfReady,
} from './queued-tasks';

export async function getSetupNewStatusCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const { userId } = auth;
  await purgeSavedDeploymentWorkerImage();

  const [
    baseStatus,
    slackAccessStatus,
    persistedRuntimeModelConfig,
    persistedRuntimeComputeConfig,
    envVarNames,
    nonSecretComputeEnvValues,
    chatgptConnected,
  ] = await Promise.all([
    getSetupBaseStatus(auth),
    getSetupSlackAccessStatus({ userId }),
    getPersistedRuntimeModelConfig(),
    getPersistedRuntimeComputeConfig(),
    getPersistedEnvironmentVariableNames(),
    getPersistedEnvironmentVariableValues([
      ...NON_SECRET_COMPUTE_ENV_VAR_NAMES,
    ]),
    isChatGptSubscriptionConnected(),
  ]);
  const activeSetupQualificationBlock =
    await getActiveSetupQualificationBlock(auth);
  let setupNewState = normalizeSetupNewState(baseStatus.setupNewState);

  if (
    setupNewState.onboardingTaskId &&
    setupNewState.suggestionTaskId === null &&
    hasSetupChatHandoffDestination(setupNewState)
  ) {
    try {
      await triggerTaskSuggestionsCommand(auth);
      setupNewState = await getPersistedSetupNewState();
    } catch (error) {
      console.error(
        `[getSetupNewStatusCommand] Failed to trigger task suggestions: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const { selectedRepositories } = await resolveSelectedRepositories(
    setupNewState.selectedRepositoryIds,
  ).catch(() => ({
    normalizedRepositoryIds: setupNewState.selectedRepositoryIds,
    selectedRepositories: [] as SelectedRepositorySummary[],
  }));

  const selectedRepositoryFullNames = selectedRepositories.map(
    (repository) => repository.fullName,
  );

  const [onboardingTask, matchingEnvironment] = await Promise.all([
    getOnboardingTaskState(setupNewState.onboardingTaskId),
    getMatchingEnvironmentSummary({
      selectedRepositoryFullNames,
      onboardingTaskStartedAt: setupNewState.onboardingTaskStartedAt,
    }),
  ]);
  const onboardingTaskStatus = onboardingTask.status;
  const onboardingTaskPhase = onboardingTask.taskPhase;
  const onboardingTaskFirstAssistantOutputAt =
    onboardingTask.firstAssistantOutputAt;

  const onboardingSucceeded =
    isSetupNewOnboardingSuccessStatus(
      onboardingTaskStatus,
      onboardingTaskPhase,
    ) && matchingEnvironment !== null;
  const onboardingEndedWithoutEnvironment =
    isSetupNewOnboardingTerminalSuccessStatus(
      onboardingTaskStatus,
      onboardingTaskPhase,
    ) && matchingEnvironment === null;
  const onboardingFailed =
    (isSetupNewOnboardingFailureStatus(onboardingTaskStatus) ||
      onboardingEndedWithoutEnvironment) &&
    !onboardingSucceeded;

  await launchQueuedSetupTasksIfReady({
    setupOnboardingTaskId: setupNewState.onboardingTaskId,
    matchingEnvironmentId: onboardingSucceeded ? matchingEnvironment.id : null,
    slackTeamId: setupNewState.slackTeamId,
    slackChannel: setupNewState.slackChannel,
    slackThreadTs: setupNewState.slackThreadTs,
    chatHandoffProvider: setupNewState.chatHandoffProvider,
    chatHandoffChannelId: setupNewState.chatHandoffChannelId,
    chatHandoffThreadId: setupNewState.chatHandoffThreadId,
    chatHandoffServiceUrl: setupNewState.chatHandoffServiceUrl,
  });

  const queuedOnboardingTasks = await getPersistedQueuedSetupTasks(
    setupNewState.onboardingTaskId,
  );
  const authSetup = buildSetupAuthStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames: envVarNames,
    selectedProvider: setupNewState.authProvider,
  });
  const modelSetup = buildSetupModelStatus({
    runtimeEnv: process.env,
    persistedModelConfig: persistedRuntimeModelConfig,
    persistedEnvVarNames: envVarNames,
    selectedProvider: setupNewState.modelProvider,
    chatgptConnected,
  });
  const computeSetup = buildSetupComputeStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames: envVarNames,
    persistedEnvVarValues: nonSecretComputeEnvValues,
    persistedComputeConfig: persistedRuntimeComputeConfig,
    selectedProvider: setupNewState.computeProvider,
  });
  // Present stale in-flight provisioning runs as failed so the wizard
  // offers a retry instead of polling forever after a web-process restart.
  setupNewState = {
    ...setupNewState,
    e2bTemplateBuild: presentSetupNewComputeProvisioning(
      setupNewState.e2bTemplateBuild,
    ),
    daytonaSnapshotBuild: presentSetupNewComputeProvisioning(
      setupNewState.daytonaSnapshotBuild,
    ),
  };

  const sourceControlConnection = await getSourceControlConnectionSummary();
  const gitlabBaseUrl = await resolveDeploymentEnvVar('GITLAB_BASE_URL');
  const sourceControlSetup = buildSetupSourceControlStatus({
    runtimeEnv: process.env,
    persistedEnvVarNames: envVarNames,
    selectedProvider: setupNewState.sourceControlProvider,
    connectedProviders: sourceControlConnection.connectedProviders,
    repositoryCounts: sourceControlConnection.repositoryCounts,
    gitlabBaseUrl,
  });

  return {
    hasGitHub: baseStatus.hasGitHub,
    hasSlack: slackAccessStatus.hasSlackUserMapping,
    hasSlackInstallation: slackAccessStatus.hasSlackInstallation,
    hasLinear: baseStatus.hasLinear,
    setupCompletedAt: baseStatus.setupCompletedAt,
    setupNewState,
    selectedRepositories,
    onboardingTaskStatus,
    onboardingTaskPhase,
    onboardingTaskFirstAssistantOutputAt,
    onboardingSucceeded,
    onboardingFailed,
    matchingEnvironment,
    queuedOnboardingTasks,
    authSetup,
    modelSetup,
    computeSetup,
    sourceControlSetup,
    setupQualification: {
      activeBlock: activeSetupQualificationBlock,
    },
  };
}
