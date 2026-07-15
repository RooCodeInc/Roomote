import type { CommunicationProvider } from '@roomote/types';

import {
  formatRepositoryEnvironmentLines,
  type RepositoryCoverage,
} from './repository-environment-coverage';

export type CiFailureTriageTrigger = 'scheduled' | 'manual' | 'webhook';

export type CiFailureTriageTriggeringRun = {
  repositoryFullName: string;
  workflowName: string;
  runUrl: string;
  headBranch: string;
  headSha: string;
};

function destinationPromptContext(provider: CommunicationProvider): {
  channelTag: string;
  surfaceLabel: string;
} {
  if (provider === 'slack') {
    return {
      channelTag: 'slack_channel_id',
      surfaceLabel: 'Slack',
    };
  }

  return {
    channelTag: 'channel_id',
    surfaceLabel: provider === 'teams' ? 'Teams' : 'Telegram',
  };
}

/**
 * Builds the one-task CI failure prompt: inspect the latest relevant red run
 * and fix it in this same task when it is real and fixable.
 */
export function buildCiFailureTriagePrompt({
  channelId,
  repositoryFullNames,
  repositoryCoverage,
  trigger,
  triggeringRun,
  hasAnnouncementThread,
  destinationProvider = 'slack',
}: {
  channelId: string;
  repositoryFullNames: string[];
  repositoryCoverage: RepositoryCoverage[];
  trigger: CiFailureTriageTrigger;
  triggeringRun?: CiFailureTriageTriggeringRun | null;
  /**
   * True when the webhook handler already posted an "investigating" root
   * message; this same task must resolve that thread.
   */
  hasAnnouncementThread?: boolean;
  /** Manager destination surface; defaults to Slack for webhook path. */
  destinationProvider?: CommunicationProvider;
}): string {
  const repository =
    repositoryFullNames[0] ??
    triggeringRun?.repositoryFullName ??
    'the target repository';
  const environmentLine = formatRepositoryEnvironmentLines(
    repositoryCoverage.filter(
      (entry) => entry.repositoryFullName === repository,
    ),
  );
  const environmentSection = environmentLine
    ? `\nEnvironment:\n${environmentLine}\n`
    : '';
  const triggeringRunSection = triggeringRun
    ? `\n  <triggering_run>
    <repository>${triggeringRun.repositoryFullName}</repository>
    <workflow>${triggeringRun.workflowName}</workflow>
    <run_url>${triggeringRun.runUrl}</run_url>
    <head_branch>${triggeringRun.headBranch}</head_branch>
    <head_sha>${triggeringRun.headSha}</head_sha>
  </triggering_run>`
    : '';

  const focus = triggeringRun
    ? `Work only the failing run in triggering_run. Inspect it with \`gh run view\` / \`gh run view --log-failed\`. Do not dig through unrelated older runs.`
    : `In ${repository}, use \`gh run list\` against the default branch to find failing runs, then take only the single most recent failure and inspect it with \`gh run view\` / \`gh run view --log-failed\`. Skip older failures.`;

  const { channelTag, surfaceLabel } =
    destinationPromptContext(destinationProvider);

  const reporting = hasAnnouncementThread
    ? `An investigating ${surfaceLabel} thread already exists for this run. Always close it out with send_chat_reply purpose "closeout" (no-op with evidence, PR link, or blocker). No progress spam.`
    : `Stay quiet on ${surfaceLabel} unless you need input, hit a blocker, or finish with a result. Prefer channel \`${channelId}\`.`;

  return `$ci-failure-triage

<task_context>
  <source>background-automation</source>
  <run_mode>investigate_and_fix</run_mode>
  <trigger>${trigger}</trigger>${triggeringRunSection}
  <${channelTag}>${channelId}</${channelTag}>
  <repository>${repository}</repository>
</task_context>

You own this CI failure end-to-end in this environment-backed workspace. Investigate and, when the failure is real and fixable, fix and open a PR in this same task. Do not re-run GitHub Actions workflows.

${focus}

If it is already green on a newer run, clearly flaky, or already covered by an open Roomote PR: close out with short evidence and stop.

If it is real:
1. Reproduce the failing job commands in this environment.
2. Make the smallest fix.
3. Re-verify.
4. Open a draft PR.
5. If it does not reproduce, no-op with evidence — do not change code.

${reporting}
${environmentSection}`;
}
