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

import { loadAutomationThreadFeedbackContext } from './automation-thread-feedback';
import {
  buildDestinationTaskPayloadFields,
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

// Manual Run now only; webhook is primary. Cap matches the old max act items.
const MANUAL_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MANUAL_TASKS = 3;
const LOG_PREFIX = '[ci-failure-triage]';

/**
 * Manual "Run now" launches up to three environment-backed investigate-and-fix
 * standard tasks (one per repository). No agent scan / work-item hop.
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

    const destination = await resolveAutomationRuntimeDestination({
      runtime,
      slackConnected: true,
    });

    if (!destination) {
      result.skippedReason = 'Manager channel is not configured.';
      return result;
    }

    if (destination.provider !== 'slack') {
      result.skippedReason = 'CI failure triage reports to Slack only for now.';
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
    const recentThreadFeedback = await loadAutomationThreadFeedbackContext({
      automationKey: 'ci_failure_triage',
      slackChannelId: channelId,
    });
    const scanWindowStart = new Date(Date.now() - MANUAL_SCAN_WINDOW_MS);
    const candidates = environmentBacked.slice(0, MAX_MANUAL_TASKS);
    let launched = 0;

    for (const coverage of candidates) {
      const environmentId = coverage.targetEnvironmentId;
      if (!environmentId) {
        continue;
      }

      // Same fingerprint scheme as webhooks so manual uses the repo-level claim
      // that webhook investigations already hold for this repository.
      const fingerprint = buildCiFailureTriageFingerprint({
        repositoryFullName: coverage.repositoryFullName,
        workflowName: 'manual-run-now',
        headBranch: 'default',
      });
      const claimed = await tryClaimCiFailureTriageInvestigation({
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
                  scanWindowStart,
                  trigger: 'manual',
                  recentThreadFeedback,
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
            channels: { slackChannelId: channelId },
          },
          { launchClass: 'automation' },
        );

        result.launchedTaskId ??= launchResult.taskId;
        launched++;
      } catch (enqueueError) {
        await releaseCiFailureTriageInvestigation({
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
        'No CI failure fix tasks were launched (no eligible repos or all claims held).';
    }

    console.log(`${LOG_PREFIX} Manual Run now launched ${launched} task(s)`);
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
