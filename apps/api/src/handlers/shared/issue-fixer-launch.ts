import {
  buildIssueFixerFixPrompt,
  buildRepositoryCoverage,
  enqueueTask,
} from '@roomote/cloud-agents/server';
import {
  db,
  getBackgroundAgentSettingsForDeployment,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import {
  TaskPayloadKind,
  type SourceControlProvider,
  type TaskSurface,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';

const LOG_PREFIX = '[issueFixerLaunch]';

export const ISSUE_FIXER_SOURCE_CONTROL_PROVIDERS = [
  'github',
  'gitlab',
  'gitea',
] as const satisfies readonly SourceControlProvider[];

export type IssueFixerSourceControlProvider =
  (typeof ISSUE_FIXER_SOURCE_CONTROL_PROVIDERS)[number];

export type IssueFixerLaunchIssue = {
  number: number;
  title: string;
  url: string;
  body?: string | null;
  labels?: string[];
  authorLogin?: string | null;
};

/**
 * Shared launch path for webhook-driven issue triage across supported SCMs.
 * Caller has already resolved the active Roomote repository row and normalized
 * the issue payload.
 */
export async function launchIssueFixerTriage({
  sourceControlProvider,
  repositoryFullName,
  issue,
  continueMention,
  githubAppSlug,
}: {
  sourceControlProvider: IssueFixerSourceControlProvider;
  repositoryFullName: string;
  issue: IssueFixerLaunchIssue;
  /** Provider-native follow-up tag humans should use (e.g. `@roomote`). */
  continueMention?: string;
  /** Required for GitHub-hosted prompt mention recovery. */
  githubAppSlug?: string;
}): Promise<WebhookResponse> {
  const settings = await getBackgroundAgentSettingsForDeployment();

  if (settings.issueFixerFrequency === 'off') {
    return { status: 'ok', message: 'Triage Issues is disabled' };
  }

  const repositoryCoverage = await buildRepositoryCoverage([
    repositoryFullName,
  ]);
  const environmentId = repositoryCoverage[0]?.targetEnvironmentId;

  if (!environmentId) {
    return {
      status: 'ok',
      message: 'Repository has no configured environment for Triage Issues',
    };
  }

  const surface = sourceControlProvider as TaskSurface;

  try {
    const description = buildIssueFixerFixPrompt({
      repositoryFullName,
      environmentId,
      trigger: 'webhook',
      sourceControlProvider,
      continueMention,
      githubAppSlug,
      repositoryCoverage,
      issue: {
        repositoryFullName,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        body: issue.body,
        labels: issue.labels ?? [],
        authorLogin: issue.authorLogin ?? null,
      },
    });

    const launchResult = await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: repositoryFullName,
            environmentId,
            selectedRepositories: [repositoryFullName],
            description,
            visibleInTranscript: false,
            sourceControlProvider,
          },
        },
        initiator: { kind: 'automation', key: 'issue_fixer' },
        workflow: 'standard',
        surface,
        trigger: 'webhook',
        visibility: 'hidden',
      },
      {
        launchClass: 'automation',
      },
    );

    await recordAutomationRunOutcome(db, {
      key: 'issue_fixer',
      status: 'succeeded',
      at: new Date(),
    });

    return {
      status: 'ok',
      message: `Launched Triage Issues for ${repositoryFullName}#${issue.number}`,
      metadata: { taskId: launchResult.taskId },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordAutomationRunOutcome(db, {
      key: 'issue_fixer',
      status: 'failed',
      at: new Date(),
      error: message,
    }).catch(() => undefined);

    console.error(
      `${LOG_PREFIX} Failed to launch Triage Issues for ${repositoryFullName}#${issue.number} (${sourceControlProvider}): ${message}`,
    );

    return { status: 'error', message };
  }
}
