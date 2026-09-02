import {
  buildIssueFixerFixPrompt,
  enqueueTask,
} from '@roomote/cloud-agents/server';
import {
  db,
  getBackgroundAgentSettingsForDeployment,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import { TaskPayloadKind, type SourceControlProvider } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { resolveMappedEnvironmentId } from './repository-environment';

const LOG_PREFIX = '[issueFixerLaunch]';

type IssueFixerSourceControlProvider = Extract<
  SourceControlProvider,
  'github' | 'gitlab' | 'gitea'
>;

type IssueFixerLaunchIssue = {
  number: number;
  title: string;
  url: string;
  body?: string | null;
  labels?: string[];
  authorLogin?: string | null;
};

/**
 * Shared launch path for webhook-driven issue implementation across supported SCMs.
 * Caller has already resolved the active Roomote repository row and normalized
 * the issue payload.
 */
export async function launchIssueFixerTriage({
  sourceControlProvider,
  repositoryId,
  repositoryFullName,
  sourceControlHost,
  issue,
  continueMention,
  githubAppSlug,
}: {
  sourceControlProvider: IssueFixerSourceControlProvider;
  /** Internal id of the host-scoped repository row resolved by the webhook. */
  repositoryId: string;
  repositoryFullName: string;
  sourceControlHost?: string | null;
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

  const environmentId = await resolveMappedEnvironmentId(repositoryId);

  if (!environmentId) {
    return {
      status: 'ok',
      message: 'Repository has no configured environment for Triage Issues',
    };
  }

  const repositoryCoverage = [
    { repositoryFullName, targetEnvironmentId: environmentId },
  ];

  try {
    const description = buildIssueFixerFixPrompt({
      repositoryFullName,
      environmentId,
      trigger: 'webhook',
      sourceControlProvider,
      continueMention,
      githubAppSlug,
      repositoryCoverage,
      additionalInstructions: settings.issueFixerInstructions,
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
            ...(sourceControlHost ? { sourceControlHost } : {}),
          },
        },
        initiator: { kind: 'automation', key: 'issue_fixer' },
        workflow: 'standard',
        surface: sourceControlProvider,
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
