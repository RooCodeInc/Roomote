import {
  buildCiFailureTriageFingerprint,
  buildCiFailureTriagePrompt,
  buildRepositoryCoverage,
  enqueueTask,
  getEnvironmentBackedCoverage,
  releaseCiFailureTriageInvestigation,
  tryClaimCiFailureTriageInvestigation,
} from '@roomote/cloud-agents/server';
import {
  db,
  getAutomationRuntime,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import {
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
} from './destination';
import {
  getActiveRepositoryFullNames,
  hasActiveGitHubInstallation,
} from './github-deployment-scope';
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

    if (!(await hasActiveGitHubInstallation())) {
      result.skippedReason = 'GitHub is not configured';
      return result;
    }

    const selectedRepositories = await getActiveRepositoryFullNames();
    const repositoryCoverage =
      await buildRepositoryCoverage(selectedRepositories);
    const environmentBacked = getEnvironmentBackedCoverage(repositoryCoverage);

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

      // Repo claim blocks double-start against an active webhook investigation.
      const fingerprint = buildCiFailureTriageFingerprint({
        repositoryFullName: coverage.repositoryFullName,
        workflowName: 'manual-run-now',
        headBranch: 'default',
      });
      const claimed = await tryClaimCiFailureTriageInvestigation({
        provider: 'github',
        repositoryFullName: coverage.repositoryFullName,
        fingerprint,
        marker: `manual:${coverage.repositoryFullName}`,
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
                description: buildCiFailureTriagePrompt({
                  channelId,
                  repositoryFullNames: [coverage.repositoryFullName],
                  repositoryCoverage: coverageSlice,
                  trigger: 'manual',
                  destinationProvider: destination.provider,
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
          provider: 'github',
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
