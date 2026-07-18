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
 * Builds the one-task Triage GitHub Issues prompt: investigate a named issue
 * and post a plan on the GitHub issue. Does not implement or open a PR.
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

  return `$plan-repo-implementation

<task_context>
  <source>issue_fixer</source>
  <run_mode>issue_plan_only</run_mode>
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

Triage GitHub issue #${issue.number} in ${repositoryFullName}. Post a concrete implementation plan on the issue. Do not implement code and do not open a pull request in this task.

Issue URL: ${issue.url}
Title: ${issue.title}
Labels: ${labels}

Issue body:
${bodyPreview || '(empty)'}

Requirements:
1. Re-fetch the live issue with \`gh\` and read comments before planning.
2. Explore the codebase enough to ground the plan in real files and patterns.
3. Write a focused implementation plan: approach, files likely touched, risks, test plan, and open questions.
4. If anything material is unclear (acceptance criteria, expected behavior, scope, constraints, ownership), ask specific clarifying questions on the GitHub issue. Prefer questions that unblock planning; do not invent product decisions.
5. Post the plan (and any clarifying questions) as a single GitHub issue comment with \`gh issue comment ${issue.number} --repo ${repositoryFullName} --body "..."\`.
6. If the issue is closed, is a pull request, already has an active plan/fix PR, or is blocked pending answers you already requested, comment briefly with that finding (or skip with a terse internal note when commenting would be noise) and stop.
7. Do not edit source files, do not commit, and do not open a PR.
8. Stay quiet on chat unless you need input outside GitHub, hit a blocker, or finish with a result.
${environmentSection}`;
}
