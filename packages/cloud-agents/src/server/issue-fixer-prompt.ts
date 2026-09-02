import {
  getGitHubFollowUpMention,
  getSourceControlProviderLabel,
  type SourceControlProvider,
} from '@roomote/types';
import { isGitHubRoomoteMentionEnabled } from '@roomote/github';

import {
  formatRepositoryEnvironmentLines,
  type RepositoryCoverage,
} from './repository-environment-coverage';
import {
  buildUntrustedContentPolicy,
  buildUntrustedExternalContentBlock,
  escapeTaskContextText,
} from './untrusted-content';

export type IssueFixerTrigger = 'manual' | 'webhook';

export type IssueFixerTriggeringIssue = {
  repositoryFullName: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  labels?: string[];
  authorLogin?: string | null;
};

function resolveContinueMention({
  sourceControlProvider,
  continueMention,
  githubAppSlug,
}: {
  sourceControlProvider: SourceControlProvider;
  continueMention?: string;
  githubAppSlug?: string;
}): string {
  const explicit = continueMention?.trim();
  if (explicit) {
    return explicit.startsWith('@') ? explicit : `@${explicit}`;
  }

  if (sourceControlProvider === 'github') {
    return getGitHubFollowUpMention(
      githubAppSlug?.trim() || 'roomote',
      isGitHubRoomoteMentionEnabled(),
    );
  }

  return '@roomote';
}

/**
 * Builds the one-task Triage Issues prompt: investigate a named issue,
 * implement the fix, and open a pull request (provider-neutral).
 */
export function buildIssueFixerFixPrompt({
  repositoryFullName,
  environmentId,
  trigger,
  issue,
  repositoryCoverage,
  sourceControlProvider = 'github',
  continueMention,
  githubAppSlug,
  additionalInstructions,
}: {
  repositoryFullName: string;
  environmentId: string;
  trigger: IssueFixerTrigger;
  issue: IssueFixerTriggeringIssue;
  repositoryCoverage?: RepositoryCoverage[];
  sourceControlProvider?: SourceControlProvider;
  /** Provider-native follow-up tag for humans (e.g. `@roomote`). */
  continueMention?: string;
  /** Deployment-configured GitHub App slug used for @mentions on GitHub. */
  githubAppSlug?: string;
  /** Optional team instructions from Triage Issues automation settings. */
  additionalInstructions?: string | null;
}): string {
  const coverage =
    repositoryCoverage ??
    ([
      {
        repositoryFullName,
        targetEnvironmentId: environmentId,
      },
    ] satisfies RepositoryCoverage[]);
  const envLines = formatRepositoryEnvironmentLines(
    coverage.filter((entry) => entry.repositoryFullName === repositoryFullName),
  );
  const environmentSection = envLines ? `\nEnvironment:\n${envLines}\n` : '';
  const labels =
    issue.labels && issue.labels.length > 0
      ? issue.labels.join(', ')
      : '(none)';
  // Issue title, labels, author, and body are authored by arbitrary SCM
  // users, so they are escaped and delimited as untrusted content.
  const escapedTitle = escapeTaskContextText(issue.title);
  const escapedLabels = escapeTaskContextText(labels);
  const escapedAuthor = escapeTaskContextText(issue.authorLogin ?? 'unknown');
  const bodyPreview = (issue.body ?? '').trim().slice(0, 4000);
  const issueBodySection = bodyPreview
    ? buildUntrustedExternalContentBlock({
        source: `${sourceControlProvider}_issue_body`,
        text: bodyPreview,
      })
    : '(empty)';
  const appMention = resolveContinueMention({
    sourceControlProvider,
    continueMention,
    githubAppSlug,
  });
  const providerLabel = getSourceControlProviderLabel(sourceControlProvider);
  const trimmedInstructions = additionalInstructions?.trim();
  const additionalInstructionsSection = trimmedInstructions
    ? `\nAdditional team instructions:\n${trimmedInstructions}\n`
    : '';

  return `$issue-fixer

<task_context>
  <source>issue_fixer</source>
  <run_mode>issue_implement</run_mode>
  <trigger>${trigger}</trigger>
  <source_control_provider>${sourceControlProvider}</source_control_provider>
  <repository_scope>${repositoryFullName}</repository_scope>
  <target_environment_id>${environmentId}</target_environment_id>
  <continue_mention>${appMention}</continue_mention>
  <issue>
    <url>${escapeTaskContextText(issue.url)}</url>
    <number>${issue.number}</number>
    <title>${escapedTitle}</title>
    <labels>${escapedLabels}</labels>
    <author>${escapedAuthor}</author>
  </issue>
</task_context>

Implement ${providerLabel} issue #${issue.number} in ${repositoryFullName}. If the issue is too unclear to ship safely, post clarifying questions as a comment and stop. Otherwise implement the fix, open a pull request, and comment the pull request URL on the issue. Do not wait for a human to tag Roomote.

Issue URL: ${issue.url}
Title: ${escapedTitle}
Labels: ${escapedLabels}

Issue body:
${issueBodySection}

${buildUntrustedContentPolicy()}
${additionalInstructionsSection}${environmentSection}`;
}
