import {
  buildCiFailureTriagePrompt,
  buildRepositoryCoverage,
  getEnvironmentBackedCoverage,
} from '@roomote/cloud-agents/server';
import { ALL_REPOSITORIES } from '@roomote/types';

import { loadAutomationThreadFeedbackContext } from './automation-thread-feedback';
import {
  getActiveRepositoryFullNames,
  hasActiveGitHubInstallation,
} from './github-deployment-scope';
import { createScheduledTriageJob } from './scheduled-triage-runner';

// CI failure triage is webhook-driven (the workflow_run handler in apps/api
// launches a scan as soon as a default-branch run fails). This job is never
// registered with a scheduler; it only serves the synchronous manual Run-now
// trigger, which sweeps all environment-backed repositories on demand.
const MANUAL_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const ciFailureTriageJob = createScheduledTriageJob({
  automationKey: 'ci_failure_triage',
  async buildScanTask({ channelId, manualTrigger }) {
    if (!(await hasActiveGitHubInstallation())) {
      return { kind: 'skip', reason: 'GitHub is not configured' };
    }

    const selectedRepositories = await getActiveRepositoryFullNames();
    const repositoryCoverage =
      await buildRepositoryCoverage(selectedRepositories);
    // CI follow-ups must reproduce the failing job before fixing it, so the
    // scan only targets repositories backed by a configured environment.
    const environmentBackedRepositories = getEnvironmentBackedCoverage(
      repositoryCoverage,
    ).map((coverage) => coverage.repositoryFullName);

    if (environmentBackedRepositories.length === 0) {
      return {
        kind: 'skip',
        reason: 'no repositories are covered by a configured environment',
      };
    }

    const recentThreadFeedback = await loadAutomationThreadFeedbackContext({
      automationKey: 'ci_failure_triage',
      slackChannelId: channelId,
    });
    // Always scan the full window: lastRunAt advances on every webhook-
    // triggered run, so anchoring to it would make Run now miss persistent
    // failures whose last failed run predates the previous pass.
    const scanWindowStart = new Date(Date.now() - MANUAL_SCAN_WINDOW_MS);

    return {
      kind: 'scan',
      payload: {
        repo: ALL_REPOSITORIES,
        selectedRepositories: environmentBackedRepositories,
        description: buildCiFailureTriagePrompt({
          channelId,
          repositoryFullNames: environmentBackedRepositories,
          repositoryCoverage,
          scanWindowStart,
          trigger: manualTrigger ? 'manual' : 'scheduled',
          recentThreadFeedback,
        }),
        trigger: 'scheduled',
        notifySlack: true,
        suggestionSource: 'ci_failure_triage',
        visibleInTranscript: false,
      },
    };
  },
});
