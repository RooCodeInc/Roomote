import {
  buildRepositoryCoverage,
  enqueueTask,
  getEnvironmentBackedCoverage,
} from '@roomote/cloud-agents/server';
import {
  db,
  getAutomationRuntime,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import {
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
} from './destination';
import {
  getActiveGitHubRepositoryFullNames,
  hasActiveGitHubInstallation,
} from './github-deployment-scope';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[issue-fixer]';

/**
 * Manual "Run now" launches one environment-backed investigate-and-fix task
 * that picks a single high-confidence open GitHub issue. Day-to-day operation
 * is webhook-driven on issues.opened / issues.reopened.
 */
export async function issueFixerJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting issue fixer evaluator`);

  const result = emptyJobResult();

  if (opts.manualTrigger !== true) {
    result.skippedReason =
      'Issue Fixer is webhook-driven; only manual Run now is supported offline.';
    return result;
  }

  try {
    const runtime = await getAutomationRuntime('issue_fixer');
    if (!runtime.enabled || runtime.scheduleMode === 'off') {
      result.skippedReason = 'Automation is disabled.';
      return result;
    }

    const connectedProviders = await listConnectedCommunicationProviders();
    const destination = await resolveAutomationRuntimeDestination({
      runtime,
      slackConnected: connectedProviders.includes('slack'),
    });

    if (!(await hasActiveGitHubInstallation())) {
      result.skippedReason = 'GitHub is not configured';
      return result;
    }

    const selectedRepositories = await getActiveGitHubRepositoryFullNames();
    const repositoryCoverage =
      await buildRepositoryCoverage(selectedRepositories);
    const environmentBacked = getEnvironmentBackedCoverage(repositoryCoverage);

    if (environmentBacked.length === 0) {
      result.skippedReason =
        'no repositories are covered by a configured environment';
      return result;
    }

    const coverage = environmentBacked[0]!;
    const environmentId = coverage.targetEnvironmentId;
    if (!environmentId) {
      result.skippedReason = 'No environment-backed repository available';
      return result;
    }

    const launchResult = await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: coverage.repositoryFullName,
            environmentId,
            selectedRepositories: [coverage.repositoryFullName],
            description: `$implement-changes

<task_context>
  <source>issue_fixer</source>
  <run_mode>manual_run_now</run_mode>
  <repository_scope>${coverage.repositoryFullName}</repository_scope>
  <target_environment_id>${environmentId}</target_environment_id>
</task_context>

Issue Fixer was triggered manually (Run now).

1. Use \`gh\` to list open issues in ${coverage.repositoryFullName} (exclude pull requests).
2. Pick the single highest-confidence open issue with clear requirements that has no active fix PR.
3. Implement the narrowest high-quality fix and open a PR that references the issue.
4. If nothing is actionable, end with a terse internal note and do not open a PR.
5. Stay quiet on chat unless you need input, hit a blocker, or finish with a result.
`,
            visibleInTranscript: false,
            ...(destination?.provider === 'slack'
              ? {
                  notifySlack: true,
                  slackChannel: destination.channelId,
                }
              : {}),
          },
        },
        initiator: { kind: 'automation', key: 'issue_fixer' },
        workflow: 'standard',
        surface: 'system',
        trigger: 'manual',
        visibility: 'hidden',
      },
      { launchClass: 'automation' },
    );

    await recordAutomationRunOutcome(db, {
      key: 'issue_fixer',
      status: 'succeeded',
      at: new Date(),
    });

    result.launchedTaskId = launchResult.taskId;
    result.completed = true;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    await recordAutomationRunOutcome(db, {
      key: 'issue_fixer',
      status: 'failed',
      at: new Date(),
      error: message,
    }).catch(() => undefined);
    return result;
  }
}
