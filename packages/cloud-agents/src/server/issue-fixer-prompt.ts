import { getGitHubAppMention } from '@roomote/types';

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
 * and post either clarifying questions or a plan on the GitHub issue.
 */
export function buildIssueFixerFixPrompt({
  repositoryFullName,
  environmentId,
  trigger,
  issue,
  repositoryCoverage,
  githubAppSlug,
}: {
  repositoryFullName: string;
  environmentId: string;
  trigger: IssueFixerTrigger;
  issue: IssueFixerTriggeringIssue;
  repositoryCoverage?: RepositoryCoverage[];
  /** Deployment-configured GitHub App slug used for @mentions. */
  githubAppSlug: string;
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
  const appMention = getGitHubAppMention(githubAppSlug.trim() || 'roomote');

  return `$plan-repo-implementation

<task_context>
  <source>issue_fixer</source>
  <run_mode>issue_plan_only</run_mode>
  <trigger>${trigger}</trigger>
  <repository_scope>${repositoryFullName}</repository_scope>
  <target_environment_id>${environmentId}</target_environment_id>
  <github_app_mention>${appMention}</github_app_mention>
  <issue>
    <url>${issue.url}</url>
    <number>${issue.number}</number>
    <title>${issue.title}</title>
    <labels>${labels}</labels>
    <author>${issue.authorLogin ?? 'unknown'}</author>
  </issue>
</task_context>

Triage GitHub issue #${issue.number} in ${repositoryFullName}. Post either clarifying questions or a concrete implementation plan as a comment on that issue. Do not implement code and do not open a pull request.

Issue URL: ${issue.url}
Title: ${issue.title}
Labels: ${labels}

Issue body:
${bodyPreview || '(empty)'}

Process:
1. Re-fetch the live issue and read comments.
2. Explore the codebase enough to ground any plan in real files and patterns.
3. If material details are missing (acceptance criteria, expected behavior, scope, constraints, ownership), post clarifying questions and stop. Do not invent product decisions.
4. Otherwise post a proposed implementation plan and stop.
5. Skip with a brief comment (or a terse internal note if a comment would be noise) when the issue is closed, is a pull request, already has a recent full plan or active fix PR, or is waiting on unanswered questions you already asked.
6. Stay quiet on chat unless you need input outside GitHub, hit a blocker, or finish with a result.
7. When asking humans to follow up so Roomote continues, tell them to tag ${appMention} (the configured GitHub App mention from task_context). Do not hard-code a different app handle.
${environmentSection}
Comment formats (post one GitHub issue comment using one of these body shapes):

**When you need clarification:**

I'd like to help with this issue, but I need some clarification to ensure I implement the right solution. Could you please provide more details on the following:

- What is the expected behavior when [scenario]?
- Could you provide more details about [unclear aspect]?
- Are there any specific constraints or requirements I should be aware of?

Please tag ${appMention} in your response with the answers, and I'll be happy to implement the fix once I have this information.

**When you have a plan:**

I've analyzed this issue and here's my proposed implementation plan:

1. Modify [file/component] to [change]
2. Add [functionality] to handle [scenario]
3. Update [tests/docs] accordingly

This approach will [explain the benefits and how it solves the issue].

Please tag ${appMention} if you'd like me to implement this, or reply with feedback on the plan.`;
}
