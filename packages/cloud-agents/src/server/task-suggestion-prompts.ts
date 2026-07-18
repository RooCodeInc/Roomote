import {
  type SuggestionCategory,
  suggestionCategorySet,
  SUGGESTION_CATEGORY_EMOJIS,
  SUGGESTION_CATEGORY_LABELS,
  type SuggestionPriority,
  suggestionPrioritySet,
  SUGGESTION_PRIORITY_EMOJIS,
  SUGGESTION_PRIORITY_LABELS,
} from '@roomote/types';

type SuggestionBadgeStyle = 'full' | 'color_only';

function buildSuggestionSlackText(params: {
  title: string;
  brief: string;
  category?: string | null;
  priority?: string | null;
  targetRepositoryFullName?: string | null;
}): string {
  const repoLabel = params.targetRepositoryFullName
    ? ` [${params.targetRepositoryFullName}](https://github.com/${params.targetRepositoryFullName})`
    : '';

  return [
    `**${buildSuggestionBadgePrefix({
      category: params.category,
      priority: params.priority,
    })}${params.title}**${repoLabel}`,
    params.brief,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSuggestionBadgePrefix(
  params: {
    category?: string | null;
    priority?: string | null;
  },
  options: { style?: SuggestionBadgeStyle } = {},
): string {
  const badges: string[] = [];
  const badgeStyle = options.style ?? 'full';

  if (params.priority && suggestionPrioritySet.has(params.priority)) {
    const priority = params.priority as SuggestionPriority;
    badges.push(
      badgeStyle === 'color_only'
        ? SUGGESTION_PRIORITY_EMOJIS[priority]
        : `${SUGGESTION_PRIORITY_EMOJIS[priority]} [${SUGGESTION_PRIORITY_LABELS[priority]}]`,
    );
  }

  if (params.category && suggestionCategorySet.has(params.category)) {
    const category = params.category as SuggestionCategory;
    badges.push(
      badgeStyle === 'color_only'
        ? `[${SUGGESTION_CATEGORY_LABELS[category]}]`
        : `${SUGGESTION_CATEGORY_EMOJIS[category]} [${SUGGESTION_CATEGORY_LABELS[category]}]`,
    );
  }

  return badges.length > 0 ? `${badges.join(' ')} ` : '';
}

function appendOptionalSections(
  baseText: string,
  sections: Array<{ heading: string; body: string | null | undefined }>,
): string {
  const renderedSections = sections
    .map(({ heading, body }) => {
      const trimmedBody = body?.trim();
      return trimmedBody ? `${heading}:\n${trimmedBody}` : null;
    })
    .filter((section): section is string => Boolean(section));

  return renderedSections.length > 0
    ? `${baseText}\n\n${renderedSections.join('\n\n')}`
    : baseText;
}

export function buildSuggestionTaskPromptText(params: {
  title: string;
  brief: string;
  investigationContext: string | null;
  readinessMessage?: string | null;
  suggestionType?: string | null;
  category?: SuggestionCategory | null;
  priority?: SuggestionPriority | null;
  targetRepositoryFullName?: string | null;
}): string {
  const baseText = buildSuggestionSlackText(params);
  const investigationContext = params.investigationContext?.trim();

  if (params.suggestionType === 'sentry_triage') {
    return buildSentryTriageSuggestionTaskPromptText({
      ...params,
      baseText,
      investigationContext,
    });
  }

  if (params.suggestionType === 'dependabot_triage') {
    return buildDependabotTriageSuggestionTaskPromptText({
      ...params,
      baseText,
      investigationContext,
    });
  }

  if (params.suggestionType === 'codeql_triage') {
    return buildCodeqlTriageSuggestionTaskPromptText({
      ...params,
      baseText,
      investigationContext,
    });
  }

  if (params.suggestionType === 'issue_fixer') {
    return buildIssueFixerSuggestionTaskPromptText({
      ...params,
      baseText,
      investigationContext,
    });
  }

  return appendOptionalSections(baseText, [
    {
      heading: 'Workspace readiness',
      body: params.readinessMessage,
    },
    {
      heading: 'Investigation context',
      body: investigationContext,
    },
  ]);
}

function buildSentryTriageSuggestionTaskPromptText(params: {
  title: string;
  brief: string;
  baseText: string;
  investigationContext: string | null | undefined;
  readinessMessage?: string | null;
  targetRepositoryFullName?: string | null;
}): string {
  const repositoryScope = params.targetRepositoryFullName?.trim() || 'unknown';
  const investigationContext = params.investigationContext?.trim();

  return appendOptionalSections(
    `$sentry-triage

<task_context>
  <source>sentry_triage_suggestion</source>
  <run_mode>human_triggered_follow_up</run_mode>
  <repository_scope>${repositoryScope}</repository_scope>
  <requested_action_title>${params.title}</requested_action_title>
</task_context>

A user chose to implement this Sentry triage follow-up suggestion:

${params.baseText}

Use the Sentry MCP already available in the task environment to re-verify the exact Sentry issue IDs, project, status, and evidence before taking action. This follow-up path should produce a reviewable code or instrumentation change, not a direct Sentry issue-state mutation.

If the evidence is ambiguous, the issue identifiers are missing, or the ownership is unclear, do not guess. Report the blocker and stop at the verified recommendation.`,
    [
      {
        heading: 'Workspace readiness',
        body: params.readinessMessage,
      },
      {
        heading: 'Investigation context from the scheduled triage run',
        body: investigationContext,
      },
    ],
  );
}

function buildDependabotTriageSuggestionTaskPromptText(params: {
  title: string;
  brief: string;
  baseText: string;
  investigationContext: string | null | undefined;
  readinessMessage?: string | null;
  targetRepositoryFullName?: string | null;
}): string {
  const repositoryScope = params.targetRepositoryFullName?.trim() || 'unknown';
  const investigationContext = params.investigationContext?.trim();

  return appendOptionalSections(
    `$update-dependencies

<task_context>
  <source>dependabot_triage_suggestion</source>
  <run_mode>alert_follow_up</run_mode>
  <repository_scope>${repositoryScope}</repository_scope>
  <requested_action_title>${params.title}</requested_action_title>
</task_context>

A user chose to implement this Dependabot triage follow-up suggestion:

${params.baseText}

Re-verify the exact open Dependabot alert or alert bundle before changing dependencies. Confirm the alert is still open, capture the package, ecosystem, manifest path, severity, vulnerable range, and first patched version, and then choose the smallest safe update set that resolves the named alert package or tightly related manifest/workspace group.

Prefer narrow manifest and lockfile changes over broad upgrade sweeps. If the cited alert is already closed, dismissed, or no longer relevant, report that and stop unless the request still names another open alert that clearly belongs in the same update.

Use the repository's native package manager and run the validation required by the dependency-update workflow before delivery. Do not ship dependency changes that fail the required validation gate.`,
    [
      {
        heading: 'Workspace readiness',
        body: params.readinessMessage,
      },
      {
        heading: 'Investigation context from the scheduled triage run',
        body: investigationContext,
      },
    ],
  );
}

function buildCodeqlTriageSuggestionTaskPromptText(params: {
  title: string;
  brief: string;
  baseText: string;
  investigationContext: string | null | undefined;
  readinessMessage?: string | null;
  targetRepositoryFullName?: string | null;
}): string {
  const repositoryScope = params.targetRepositoryFullName?.trim() || 'unknown';
  const investigationContext = params.investigationContext?.trim();

  return appendOptionalSections(
    `$implement-changes

<task_context>
  <source>codeql_triage_suggestion</source>
  <run_mode>alert_follow_up</run_mode>
  <repository_scope>${repositoryScope}</repository_scope>
  <requested_action_title>${params.title}</requested_action_title>
</task_context>

A user chose to implement this CodeQL triage follow-up suggestion:

${params.baseText}

Re-verify the exact open CodeQL or code-scanning alert before changing source code. Confirm the alert is still open, capture the rule ID, severity, category, affected path, and line range when available, and then choose the smallest secure remediation that clears the named alert or tightly related alert family.

Prefer narrow security fixes over broad rewrites. If the cited alert is already closed, dismissed, or no longer relevant, report that and stop unless the request still names another open alert that clearly belongs in the same remediation.

Run the repository's normal validation before delivery. Do not ship changes that fail the required validation gate.`,
    [
      {
        heading: 'Workspace readiness',
        body: params.readinessMessage,
      },
      {
        heading: 'Investigation context from the scheduled triage run',
        body: investigationContext,
      },
    ],
  );
}

function buildIssueFixerSuggestionTaskPromptText(params: {
  title: string;
  brief: string;
  baseText: string;
  investigationContext: string | null | undefined;
  readinessMessage?: string | null;
  targetRepositoryFullName?: string | null;
}): string {
  const repositoryScope = params.targetRepositoryFullName?.trim() || 'unknown';
  const investigationContext = params.investigationContext?.trim();

  return appendOptionalSections(
    `$implement-changes

<task_context>
  <source>issue_fixer_suggestion</source>
  <run_mode>issue_follow_up</run_mode>
  <repository_scope>${repositoryScope}</repository_scope>
  <requested_action_title>${params.title}</requested_action_title>
</task_context>

A user chose to implement this Issue Fixer follow-up suggestion:

${params.baseText}

Re-verify the exact open GitHub issue before changing source code. Confirm the issue is still open, capture the issue URL/number, title, labels, acceptance criteria, and relevant comment decisions, and then choose the smallest high-quality fix that satisfies the named issue.

Prefer narrow, targeted fixes over broad rewrites. If the cited issue is already closed or already resolved by an open PR, report that and stop unless the request still names another open issue that clearly belongs in the same change.

Run the repository's normal validation before delivery. Do not ship changes that fail the required validation gate. When opening a PR, reference the issue number so it can be linked or closed.`,
    [
      {
        heading: 'Workspace readiness',
        body: params.readinessMessage,
      },
      {
        heading: 'Investigation context from the scheduled Issue Fixer run',
        body: investigationContext,
      },
    ],
  );
}
