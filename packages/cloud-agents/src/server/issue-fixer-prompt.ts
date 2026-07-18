import {
  formatRepositoryEnvironmentLines,
  type RepositoryCoverage,
} from './repository-environment-coverage';

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

/**
 * Builds the one-task Issue Fixer prompt: fix the named GitHub issue in this
 * same task (not a batch scan), matching Review Code / CI Failure immediacy.
 */
export function buildIssueFixerFixPrompt({
  repositoryFullName,
  environmentId,
  trigger,
  issue,
  repositoryCoverage,
}: {
  repositoryFullName: string;
  environmentId: string;
  trigger: IssueFixerTrigger;
  issue: IssueFixerTriggeringIssue;
  repositoryCoverage?: RepositoryCoverage[];
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
  const bodyPreview = (issue.body ?? '').trim().slice(0, 4000);

  return `$implement-changes

<task_context>
  <source>issue_fixer</source>
  <run_mode>issue_fix</run_mode>
  <trigger>${trigger}</trigger>
  <repository_scope>${repositoryFullName}</repository_scope>
  <target_environment_id>${environmentId}</target_environment_id>
  <issue>
    <url>${issue.url}</url>
    <number>${issue.number}</number>
    <title>${issue.title}</title>
    <labels>${labels}</labels>
    <author>${issue.authorLogin ?? 'unknown'}</author>
  </issue>
</task_context>

Fix GitHub issue #${issue.number} in ${repositoryFullName} immediately in this task.

Issue URL: ${issue.url}
Title: ${issue.title}
Labels: ${labels}

Issue body:
${bodyPreview || '(empty)'}

Requirements:
1. Re-fetch the live issue with \`gh\` to confirm it is still open and capture any comments or decisions before coding.
2. Implement the narrowest high-quality fix that satisfies the issue. Avoid unrelated churn.
3. Run the repository's normal validation before delivery.
4. Open a PR that references #${issue.number} so it can be linked or closed.
5. If the issue is already closed, already has an active fix PR, or is blocked on product decisions, report that and stop without guessing.
6. Stay quiet on chat unless you need input, hit a blocker, or finish with a result.
${environmentSection}`;
}
