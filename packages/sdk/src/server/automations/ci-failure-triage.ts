import {
  buildCiFailureTriageFingerprint,
  buildCiFailureTriagePrompt,
  buildRepositoryCoverage,
  enqueueTask,
  getEnvironmentBackedCoverage,
  releaseCiFailureTriageInvestigation,
  tryClaimCiFailureTriageInvestigation,
  type CiFailureTriageTriggeringRun,
} from '@roomote/cloud-agents/server';
import {
  db,
  getAutomationRuntime,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import {
  getGitLabPipelineFailureEvidence,
  getLatestGitLabPipeline,
} from '@roomote/gitlab';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  TaskPayloadKind,
  type SourceControlProvider,
} from '@roomote/types';

import {
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
} from './destination';
import { getActiveRepositoriesForProviders } from './github-deployment-scope';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[ci-failure-triage]';

/**
 * Manual "Run now" launches a single environment-backed investigate-and-fix
 * task for the first eligible repository that is free of an active claim.
 * The task focuses on the latest default-branch failure only.
 */
export async function ciFailureTriageJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting ci failure triage evaluator`);

  const result = emptyJobResult();

  if (opts.manualTrigger !== true) {
    result.skippedReason =
      'CI failure triage is webhook-driven; only manual Run now is supported offline.';
    return result;
  }

  try {
    const runtime = await getAutomationRuntime('ci_failure_triage');
    if (!runtime.enabled || runtime.scheduleMode === 'off') {
      result.skippedReason = 'Automation is disabled.';
      return result;
    }

    const connectedProviders = await listConnectedCommunicationProviders();
    const destination = await resolveAutomationRuntimeDestination({
      runtime,
      slackConnected: connectedProviders.includes('slack'),
    });

    if (!destination) {
      result.skippedReason = 'Manager channel is not configured.';
      return result;
    }

    const supportedProviders =
      (getTriggerableBackgroundAutomationDescriptorByKey('ci_failure_triage')
        ?.supportedSourceControlProviders ?? [
        'github',
      ]) as SourceControlProvider[];

    const selectedRepositories =
      await getActiveRepositoriesForProviders(supportedProviders);

    if (selectedRepositories.length === 0) {
      result.skippedReason =
        'No active repositories for supported source-control providers.';
      return result;
    }

    const repositoryCoverage = await buildRepositoryCoverage(
      selectedRepositories.map((repo) => repo.fullName),
    );
    const environmentBacked = getEnvironmentBackedCoverage(repositoryCoverage);
    const repositoryByFullName = new Map(
      selectedRepositories.map((repo) => [repo.fullName, repo]),
    );

    if (environmentBacked.length === 0) {
      result.skippedReason =
        'no repositories are covered by a configured environment';
      return result;
    }

    const channelId = destination.channelId;
    let launched = 0;

    for (const coverage of environmentBacked) {
      const environmentId = coverage.targetEnvironmentId;
      if (!environmentId) {
        continue;
      }

      const selectedRepository = repositoryByFullName.get(
        coverage.repositoryFullName,
      );
      if (!selectedRepository) {
        continue;
      }

      const sourceControlProvider = selectedRepository.sourceControlProvider;
      let triggeringRun: CiFailureTriageTriggeringRun | undefined;
      let workflowName = 'manual-run-now';
      let headBranch = 'default';
      let claimMarker = `manual:${coverage.repositoryFullName}`;

      if (sourceControlProvider === 'gitlab') {
        const projectId = selectedRepository.externalRepoId?.trim();
        if (!projectId) {
          result.errors.push(
            `${coverage.repositoryFullName}: GitLab project id is unavailable`,
          );
          continue;
        }

        try {
          const latestPipeline = await getLatestGitLabPipeline({
            projectId,
            ref: selectedRepository.defaultBranch,
          });

          if (
            !latestPipeline ||
            latestPipeline.status.toLowerCase() !== 'failed'
          ) {
            console.log(
              `${LOG_PREFIX} Skipping ${coverage.repositoryFullName}: latest GitLab default-branch pipeline is not failed`,
            );
            continue;
          }

          const failureEvidence = await getGitLabPipelineFailureEvidence({
            projectId,
            pipelineId: latestPipeline.id,
          });
          workflowName = latestPipeline.name?.trim() || 'pipeline';
          headBranch = latestPipeline.ref;
          claimMarker = latestPipeline.web_url;
          triggeringRun = {
            repositoryFullName: coverage.repositoryFullName,
            workflowName,
            runUrl: latestPipeline.web_url,
            headBranch,
            headSha: latestPipeline.sha,
            provider: 'gitlab',
            failureEvidence,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${coverage.repositoryFullName}: failed to inspect GitLab pipeline (${message})`,
          );
          continue;
        }
      }

      // Repo claim blocks double-start against an active webhook investigation.
      const fingerprint = buildCiFailureTriageFingerprint({
        repositoryFullName: coverage.repositoryFullName,
        workflowName,
        headBranch,
      });
      const claimed = await tryClaimCiFailureTriageInvestigation({
        provider: sourceControlProvider,
        repositoryFullName: coverage.repositoryFullName,
        fingerprint,
        marker: claimMarker,
      });

      if (!claimed) {
        console.log(
          `${LOG_PREFIX} Skipping ${coverage.repositoryFullName}: active investigation claim`,
        );
        continue;
      }

      const coverageSlice = [
        {
          repositoryFullName: coverage.repositoryFullName,
          targetEnvironmentId: environmentId,
        },
      ];

      try {
        const launchResult = await enqueueTask(
          {
            task: {
              type: TaskPayloadKind.StandardTask,
              payload: {
                repo: coverage.repositoryFullName,
                environmentId,
                selectedRepositories: [coverage.repositoryFullName],
                ...(sourceControlProvider !== 'github'
                  ? { sourceControlProvider }
                  : {}),
                ...(sourceControlProvider !== 'github' &&
                selectedRepository.host
                  ? { sourceControlHost: selectedRepository.host }
                  : {}),
                description: buildCiFailureTriagePrompt({
                  channelId,
                  repositoryFullNames: [coverage.repositoryFullName],
                  repositoryCoverage: coverageSlice,
                  trigger: 'manual',
                  destinationProvider: destination.provider,
                  sourceControlProvider,
                  triggeringRun,
                }),
                ...buildDestinationTaskPayloadFields(destination),
                visibleInTranscript: false,
              },
            },
            initiator: { kind: 'automation', key: 'ci_failure_triage' },
            workflow: 'standard',
            surface: 'system',
            trigger: 'manual',
            visibility: 'hidden',
            ...(destination.provider === 'slack'
              ? { channels: { slackChannelId: channelId } }
              : {}),
          },
          { launchClass: 'automation' },
        );

        result.launchedTaskId = launchResult.taskId;
        launched = 1;
        // One failure at a time — do not fan out.
        break;
      } catch (enqueueError) {
        await releaseCiFailureTriageInvestigation({
          provider: sourceControlProvider,
          repositoryFullName: coverage.repositoryFullName,
          fingerprint,
        }).catch(() => undefined);
        const message =
          enqueueError instanceof Error
            ? enqueueError.message
            : String(enqueueError);
        result.errors.push(
          `${coverage.repositoryFullName}: failed to launch (${message})`,
        );
        console.error(
          `${LOG_PREFIX} Failed to launch for ${coverage.repositoryFullName}: ${message}`,
        );
      }
    }

    await recordAutomationRunOutcome(db, {
      key: 'ci_failure_triage',
      status: 'succeeded',
      at: new Date(),
    });

    if (launched === 0) {
      result.skippedReason =
        result.errors.length > 0
          ? 'Failed to launch the CI failure fix task.'
          : 'No CI failure fix task was launched (no eligible repo or claim held).';
    }

    console.log(
      `${LOG_PREFIX} Manual Run now launched ${launched} task for latest failure focus`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    await recordAutomationRunOutcome(db, {
      key: 'ci_failure_triage',
      status: 'failed',
      at: new Date(),
      error: message,
    }).catch(() => undefined);
    console.error(`${LOG_PREFIX} Failed: ${message}`);
    return result;
  }
}
