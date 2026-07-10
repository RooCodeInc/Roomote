import { type WorkItemStatus } from '@roomote/types';

// A suggestion that is still open or was already launched into a task is
// "already handled" for de-dup guidance and should not be re-suggested.
const ACTIVE_SUGGESTION_STATUS_LABELS: WorkItemStatus[] = ['open', 'launched'];

export interface PreviousSuggestion {
  title: string;
  brief: string;
  status: WorkItemStatus;
}

type SuggestedTaskRouteContext = {
  destinationChannelName: string;
  excludedGroupLabels?: string[];
  groupLabel: string;
  isFallbackRoute?: boolean;
  routeInstructions: string;
};

function buildPreviousSuggestionsSection(
  previousSuggestions: PreviousSuggestion[] | undefined,
): string {
  if (!previousSuggestions || previousSuggestions.length === 0) {
    return '';
  }

  const activeStatusLabels = ACTIVE_SUGGESTION_STATUS_LABELS.join(' or ');

  const previousSuggestionLines = previousSuggestions
    .slice(0, 20)
    .map((suggestion) => {
      const truncatedBrief =
        suggestion.brief.length > 200
          ? `${suggestion.brief.slice(0, 200)}...`
          : suggestion.brief;

      return `- [${suggestion.status}] ${suggestion.title}: ${truncatedBrief}`;
    })
    .join('\n');

  return `\n\nPreviously suggested ideas (status shows whether each suggestion is still open, was already launched, or was dismissed; do NOT re-suggest ${activeStatusLabels} ideas, and avoid repeating dismissed ones):\n${previousSuggestionLines}`;
}

function buildRecentThreadFeedbackSection(
  recentThreadFeedback: string | null | undefined,
): string {
  const trimmedFeedback = recentThreadFeedback?.trim();

  return trimmedFeedback
    ? `\n\nRecent feedback from earlier suggestion threads:\n${trimmedFeedback}`
    : '';
}

export function buildSuggestedTasksPrompt(input: {
  repositoryFullNames: string[];
  repositoryCoverage?: Array<{
    repositoryFullName: string;
    targetEnvironmentId?: string | null;
  }>;
  routeContext?: SuggestedTaskRouteContext | null;
  setupGuidance: string | null;
  suggesterInstructions?: string | null;
  previousSuggestions?: PreviousSuggestion[];
  recentThreadFeedback?: string | null;
}): string {
  const repositoryLines = [...input.repositoryFullNames]
    .sort((left, right) => left.localeCompare(right))
    .map((repositoryFullName) => `- ${repositoryFullName}`)
    .join('\n');
  const repositoryCoverageLines = (input.repositoryCoverage ?? [])
    .filter(
      (
        coverage,
      ): coverage is {
        repositoryFullName: string;
        targetEnvironmentId: string;
      } => Boolean(coverage.targetEnvironmentId),
    )
    .sort((left, right) =>
      left.repositoryFullName.localeCompare(right.repositoryFullName),
    )
    .map(
      (coverage) =>
        `- ${coverage.repositoryFullName} -> environment ${coverage.targetEnvironmentId}`,
    )
    .join('\n');

  const setupGuidanceSection = input.setupGuidance?.trim()
    ? `\n\nAdditional setup context from the user:\n${input.setupGuidance.trim()}`
    : '';
  const suggesterInstructionsSection = input.suggesterInstructions?.trim()
    ? `\n\nCustom suggestion preferences from the user:\n${input.suggesterInstructions.trim()}`
    : '';
  const previousSuggestionsSection = buildPreviousSuggestionsSection(
    input.previousSuggestions,
  );
  const recentThreadFeedbackSection = buildRecentThreadFeedbackSection(
    input.recentThreadFeedback,
  );
  const routeContextSection = input.routeContext
    ? (() => {
        const excludedGroups =
          input.routeContext.excludedGroupLabels &&
          input.routeContext.excludedGroupLabels.length > 0
            ? `\nOther defined groups to exclude from this run:\n${input.routeContext.excludedGroupLabels
                .map((groupLabel) => `- ${groupLabel}`)
                .join('\n')}`
            : '';
        const fallbackLine = input.routeContext.isFallbackRoute
          ? 'Only surface ideas that are uncategorized, ambiguous, or clearly span multiple groups.'
          : 'Do not surface ideas that clearly belong to one of the other defined groups.';

        return `\n\nRoute-specific guidance:\nThis run is only for the following idea cluster: ${input.routeContext.groupLabel}\n${input.routeContext.routeInstructions.trim()}\nPost accepted suggestions to ${input.routeContext.destinationChannelName}.\n${fallbackLine}${excludedGroups}`;
      })()
    : '';
  const repositoryCoverageSection = repositoryCoverageLines
    ? `\n\nRepository environments:\n${repositoryCoverageLines}`
    : '';

  return `Scan the repositories and suggest the highest-value tasks the team should work on next.

Repositories:
${repositoryLines}
${repositoryCoverageSection}
${setupGuidanceSection}
${suggesterInstructionsSection}
${routeContextSection}
${previousSuggestionsSection}
${recentThreadFeedbackSection}

Start by scanning the structure of each repository - directory layout, package boundaries, app surfaces, API entry points, integration handlers, and other major subsystem seams - to understand what areas exist and which ones are high-value to explore. Use repo structure, user-facing importance, operator impact, and any setup guidance the user provided to decide where to investigate first.

Also review recent activity on each repository - merged pull requests, recent commits on the default branch, and any open PRs - to understand what the team has been working on recently. Use the available GitHub MCP tools to inspect that activity yourself. Treat recent activity as a secondary signal for targeted follow-up investigations, not as the primary source of every investigation thread.

Do not limit yourself to recently changed code. A repository can still be a strong candidate for exploration even if the most valuable issues are in older or quieter parts of the codebase.

Sources of suggestions (use all of these — aim for a diverse mix across categories):
- open-ended exploration of important subsystems, user journeys, and operator workflows
- follow-ups and next steps from recently merged PRs and commits
- real user-facing bugs and clearly broken behavior
- async, state, race, ordering, or stale-data bugs
- auth, authorization, token-handling, or data-exposure issues
- API contract mismatches, validation gaps, and edge-case failures
- TODO, FIXME, or HACK markers only when the surrounding code shows a concrete current failure or missing user-critical handling
- code quality and maintainability issues: overly complex functions, duplicated logic, poor abstractions, dead code, or confusing structure that is likely to slow the team down or cause real problems
- developer experience improvements: confusing APIs, missing or misleading types, poor error messages, clunky configuration, or awkward internal interfaces that make the codebase harder to work with
- performance opportunities: obviously inefficient queries, unnecessary re-renders, missing caching, N+1 patterns, or hot paths doing redundant work
- missing or incomplete functionality: features that are partially implemented, user-facing flows with dead ends, or documented capabilities that don't actually work
- test gaps: important code paths with no test coverage, especially in critical areas like auth, data persistence, runtime execution, or integration handlers
- observability and operational improvements: missing logging in failure paths, unhelpful error messages returned to users, or gaps in monitoring that would make debugging production issues harder

Investigation method:
- use two investigation modes:
  - exploration mode is primary. Most investigation time should go to open-ended exploration of important areas or subsystems.
  - recent-activity mode is secondary. Reserve a small part of the run for hypothesis-driven follow-ups to recent PRs, commits, or open PRs.
- select exploration areas by:
  - scanning the repo's directory structure and package layout to understand what subsystems exist
  - prioritizing user-facing and operator-facing surfaces such as auth flows, API endpoints, webhook handlers, data persistence, integration entry points (Slack, Linear, GitHub), task lifecycle, and error handling boundaries
  - using any setup guidance from the user to weight areas that are easier to validate or especially important
  - spreading exploration across different subsystems instead of clustering everything in one area
  - not limiting yourself to areas touched by recent activity
- identify a generous number of candidate investigation threads across both modes. Each thread should have a clear topic: either an area/subsystem to explore or a specific recent-activity hypothesis to check.
- aim for roughly 6-8 exploration threads across different subsystems or areas and roughly 1-2 recent-activity follow-ups. The exact numbers can flex based on repo size and activity level, but exploration should always be the majority.
- investigate directly in the active OpenCode session. Do not spawn child agent processes or depend on another CLI.
- collect candidate findings as you go, but do not submit until you have reviewed all selected investigation threads.
- for each candidate finding, record the repository, file paths, relevant functions or variables, the failure mechanism, a concrete repro or user-impact scenario, and a confidence level.
- RANKING PHASE (mandatory, after investigation):
  - rank all candidate findings together in a single pass.
  - apply editorial filtering and adversarial verification only after the full candidate set is collected.
  - CATEGORY DIVERSITY (mandatory): the final set of 5 suggestions must include at least 2 different categories (from: bug, security, chore, feature, improvement). Avoid submitting a batch that is entirely bugs or entirely one category. If all top findings happen to be bugs, actively look for the best non-bug findings (improvements, features, chores) to include. A good target mix is roughly 2-3 bugs/security findings and 2-3 improvement/feature/chore findings, but quality still comes first — do not include low-quality findings just for diversity.
  - select the top 5 only from the combined verified pool.
  - repository weighting must come only from the task's stated prioritization criteria such as user-facing importance, operator impact, and validation strength.
- your role is investigator and editor: identify what is worth checking, inspect the code, verify the evidence, then decide which findings meet the bar.

Rules:
- Do not change files.
- Ignore pure formatting nitpicks, trivial naming preferences, and speculative concerns. Structural code quality findings are welcome when they address genuinely confusing, fragile, or overly complex code - not cosmetic preferences.
- For each finding, verify it is grounded in the current codebase by checking that the cited file paths exist and the cited snippets match the current files, then actively try to disprove it before keeping it.
- Keep only high-signal findings that are clearly grounded and likely to matter to real users or operators.
- Avoid broad refactors, migrations, or overlapping ideas.
- Every suggestion must be attributable to exactly one repository.
- Use the repository environment list only to copy the matching \`targetEnvironmentId\` onto suggestions for that repository when one is listed.
- Do not treat a missing environment as a reason to avoid an otherwise strong repository-specific suggestion.
- Do not return ideas that genuinely require cross-repository execution unless you can tie the launch target to one repository.
- Each suggestion should cover a different subsystem, flow, or file area when possible.
- Submit suggestions only with the submit_task_suggestions tool.
- Aim for 5 distinct suggestions in priority order.
- Return at most 5.
- Only return fewer than 5 if you truly cannot find 5 high-signal findings that survive scrutiny.
- Submit an empty list only if nothing survives the bar.
- Each submitted suggestion must use a short title and a concise brief covering the exact issue and user impact.
- Each \`brief\` must stay within 2-3 sentences and include one concrete example scenario showing how the issue manifests in practice.
- Each submitted suggestion must include:
  - \`category\`: one of 'bug', 'security', 'chore', 'feature', or 'improvement'. Classify based on the nature of the finding.
  - \`priority\`: one of 'P0', 'P1', 'P2', or 'P3'. Classify based on severity and user impact:
    - P0: actively breaking user-facing functionality or causing data loss
    - P1: significant bug or gap affecting common workflows
    - P2: real issue but limited scope or reasonable workaround exists
    - P3: minor improvement, edge case, or nice-to-have fix
  - \`investigationContext\`: detailed implementation evidence for the agent who will fix it, capped at 4000 characters. Include specific file paths, function or variable names, the exact failure mechanism, relevant line references or tiny code snippets, and a rough suggested approach. This field is hidden from Slack users and only passed to the implementing agent.
  - \`targetRepositoryFullName\`: the single repository that owns the idea
  - \`targetEnvironmentId\`: include this when the repository environment list provides one for that repository`;
}
