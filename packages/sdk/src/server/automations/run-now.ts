import type { TriggerableBackgroundAutomationKey } from '@roomote/types';

import { announcerJob } from './announcer';
import { ciFailureTriageJob } from './ci-failure-triage';
import { codeQualityAuditorJob } from './code-quality-auditor';
import { codeqlTriageJob } from './codeql-triage';
import { conflictScanJob } from './conflict-scan';
import { dependabotTriageJob } from './dependabot-triage';
import { issueFixerJob } from './issue-fixer';
import { managerStatsJob } from './manager-stats';
import { providerUsageLimitJob } from './provider-usage-limit';
import { securityAuditorJob } from './security-auditor';
import { sentryTriageJob } from './sentry-triage';
import { suggesterJob } from './suggester';
import type {
  AutomationJobResult,
  AutomationRunNowResult,
  AutomationRunOpts,
} from './types';

const AUTOMATION_RUNNERS: Record<
  TriggerableBackgroundAutomationKey,
  (opts?: AutomationRunOpts) => Promise<AutomationJobResult>
> = {
  conflict_resolver: conflictScanJob,
  suggester: suggesterJob,
  announcer: announcerJob,
  manager_stats: managerStatsJob,
  provider_usage_limit: providerUsageLimitJob,
  sentry_triage: sentryTriageJob,
  dependabot_triage: dependabotTriageJob,
  codeql_triage: codeqlTriageJob,
  issue_fixer: issueFixerJob,
  security_auditor: securityAuditorJob,
  code_quality_auditor: codeQualityAuditorJob,
  ci_failure_triage: ciFailureTriageJob,
};

export function getAutomationRunner(
  key: TriggerableBackgroundAutomationKey,
): (opts?: AutomationRunOpts) => Promise<AutomationJobResult> {
  return AUTOMATION_RUNNERS[key];
}

/**
 * Synchronous manual "Run now": invokes the same runner the scheduler uses,
 * inline, and maps the pass result to a user-facing outcome.
 */
export async function runAutomationNow(
  key: TriggerableBackgroundAutomationKey,
  opts: AutomationRunOpts = {},
): Promise<AutomationRunNowResult> {
  let result: AutomationJobResult;

  try {
    result = await AUTOMATION_RUNNERS[key]({
      ...opts,
      manualTrigger: true,
    });
  } catch (error) {
    return {
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.launchedTaskId) {
    return { outcome: 'launched', taskId: result.launchedTaskId };
  }

  if (result.errors.length > 0) {
    return { outcome: 'failed', error: result.errors.join('; ') };
  }

  if (result.skippedReason) {
    return { outcome: 'skipped', reason: result.skippedReason };
  }

  if (result.completed) {
    return { outcome: 'completed' };
  }

  return { outcome: 'skipped', reason: 'Nothing to do.' };
}
