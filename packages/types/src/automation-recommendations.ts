import type { CustomAutomationScheduleMode } from './background-agents';
import type { TriggerableBackgroundAutomationKey } from './background-automation-registry';
import { getTriggerableBackgroundAutomationDescriptorByKey } from './background-automation-registry';
import {
  sourceControlProviders,
  type SourceControlProvider,
} from './source-control';

export const AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION = 1;

export type RecommendationCategory =
  | 'quality'
  | 'security'
  | 'maintenance'
  | 'delivery'
  | 'communication';

export type RecommendationSignal =
  | 'active_pr_flow'
  | 'merged_prs'
  | 'open_prs'
  | 'conflicts'
  | 'ci_failures'
  | 'dependabot_alerts'
  | 'codeql_alerts'
  | 'dependency_manifests'
  | 'docs';

export type RecommendationScoringRule = {
  signal: RecommendationSignal;
  weight: number;
  explanation: (value: number, repositoryCount: number) => string;
};

export type AutomationRecommendationCandidate =
  | {
      id: string;
      source: 'built_in';
      automationKey: TriggerableBackgroundAutomationKey | 'review_code';
      title: string;
      defaultScheduleMode: string;
      environmentPolicy: 'not_required' | 'optional' | 'required';
      category: RecommendationCategory;
      scoringRules: RecommendationScoringRule[];
    }
  | {
      id: string;
      source: 'cookbook';
      cookbookSlug: string;
      title: string;
      template: {
        name: string;
        prompt: string;
        scheduleMode: CustomAutomationScheduleMode;
        workspace: 'all_repositories';
        destination: 'none';
      };
      environmentPolicy: 'not_required' | 'optional';
      category: RecommendationCategory;
      scoringRules: RecommendationScoringRule[];
    };

export type RepositoryAutomationSignals = {
  repositoryId: string;
  repositoryName: string;
  sourceControlProvider: SourceControlProvider;
  mergedPrs30d: number;
  openPrs: number;
  conflicts: number;
  ciFailures30d: number;
  dependabotAlerts: number;
  codeqlAlerts: number;
  dependencyManifests: number;
  docs: number;
  partial?: boolean;
};

export type MergedAutomationRecommendationSignals = Omit<
  RepositoryAutomationSignals,
  'repositoryId' | 'repositoryName' | 'sourceControlProvider'
> & {
  repositoryCount: number;
  sourceControlProviders: SourceControlProvider[];
};

const signalValue = (
  signals: MergedAutomationRecommendationSignals,
  signal: RecommendationSignal,
) => {
  const values: Record<RecommendationSignal, number> = {
    active_pr_flow: signals.openPrs + signals.mergedPrs30d,
    merged_prs: signals.mergedPrs30d,
    open_prs: signals.openPrs,
    conflicts: signals.conflicts,
    ci_failures: signals.ciFailures30d,
    dependabot_alerts: signals.dependabotAlerts,
    codeql_alerts: signals.codeqlAlerts,
    dependency_manifests: signals.dependencyManifests,
    docs: signals.docs,
  };
  return values[signal];
};

const formatCount = (value: number, noun: string) => `${value} ${noun}`;

const activePrRule = (weight: number): RecommendationScoringRule => ({
  signal: 'active_pr_flow',
  weight,
  explanation: (value, repositoryCount) =>
    `Your repos have active PR flow (${formatCount(value, 'recent PRs')} across ${repositoryCount} repos), so Roomote can help keep the work moving.`,
});

const mergedPrRule = (weight: number): RecommendationScoringRule => ({
  signal: 'merged_prs',
  weight,
  explanation: (value, repositoryCount) =>
    `You merged ${formatCount(value, 'PRs')} across ${repositoryCount} repos in the last 30 days, so Roomote can help keep up with the pace of change.`,
});

const openPrRule = (weight: number): RecommendationScoringRule => ({
  signal: 'open_prs',
  weight,
  explanation: (value) =>
    `Your repos have ${formatCount(value, 'open PRs')}, and Roomote can help keep them moving.`,
});

function fallbackRecommendationExplanation(
  candidate: AutomationRecommendationCandidate,
): string {
  switch (candidate.id) {
    case 'built-in.review-code':
      return 'Roomote can review your pull requests as they open and flag issues before they merge.';
    case 'built-in.code-quality-auditor':
      return 'As your repositories evolve, Roomote can run regular code quality checks and surface actionable fixes.';
    case 'built-in.security-auditor':
      return 'Roomote can regularly check your repositories for security issues and surface focused fixes.';
    case 'built-in.resolve-pr-conflicts':
      return 'Roomote can watch for merge conflicts and resolve safe conflicts in open pull requests.';
    case 'built-in.dependabot-triage':
      return 'Your repos seem to have Dependabot alerts, and Roomote can handle those for you.';
    case 'built-in.codeql-triage':
      return 'Your repos seem to have CodeQL alerts, and Roomote can handle those for you.';
    case 'built-in.ci-failure-triage':
      return 'Your CI setup can lead to default branch failures. Enable this to automatically fix broken builds.';
    case 'cookbook.scheduled-housekeeping':
      return 'Roomote can regularly check your repositories for dependency drift, stale flags, and flaky-test maintenance work.';
    default:
      return `Your repositories are connected, so Roomote can help with ${candidate.title.toLowerCase()}.`;
  }
}

export const AUTOMATION_RECOMMENDATION_CATALOG: readonly AutomationRecommendationCandidate[] =
  [
    {
      id: 'built-in.review-code',
      source: 'built_in',
      automationKey: 'review_code',
      title: 'Review Code',
      defaultScheduleMode: 'off',
      environmentPolicy: 'not_required',
      category: 'quality',
      scoringRules: [openPrRule(5), activePrRule(2)],
    },
    {
      id: 'built-in.code-quality-auditor',
      source: 'built_in',
      automationKey: 'code_quality_auditor',
      title: 'Code Quality Auditor',
      defaultScheduleMode: 'weekly',
      environmentPolicy: 'not_required',
      category: 'quality',
      scoringRules: [mergedPrRule(4), activePrRule(2)],
    },
    {
      id: 'built-in.security-auditor',
      source: 'built_in',
      automationKey: 'security_auditor',
      title: 'Security Auditor',
      defaultScheduleMode: 'weekly',
      environmentPolicy: 'not_required',
      category: 'security',
      scoringRules: [mergedPrRule(3), activePrRule(1)],
    },
    {
      id: 'built-in.resolve-pr-conflicts',
      source: 'built_in',
      automationKey: 'conflict_resolver',
      title: 'Resolve PR Conflicts',
      defaultScheduleMode: 'daily',
      environmentPolicy: 'not_required',
      category: 'delivery',
      scoringRules: [
        {
          signal: 'conflicts',
          weight: 12,
          explanation: (value) =>
            `Your repos have ${formatCount(value, 'open PR conflicts')}, and Roomote can help resolve the safe ones.`,
        },
        openPrRule(2),
      ],
    },
    {
      id: 'built-in.dependabot-triage',
      source: 'built_in',
      automationKey: 'dependabot_triage',
      title: 'Triage Dependabot Alerts',
      defaultScheduleMode: 'weekly',
      environmentPolicy: 'not_required',
      category: 'maintenance',
      scoringRules: [
        {
          signal: 'dependabot_alerts',
          weight: 10,
          explanation: (value) =>
            `Your repos have ${formatCount(value, 'open Dependabot alerts')}, and Roomote can handle those for you.`,
        },
        {
          signal: 'dependency_manifests',
          weight: 2,
          explanation: (value) =>
            `Your repos include dependency manifests in ${formatCount(value, 'repos')}, so Roomote can help keep updates moving.`,
        },
      ],
    },
    {
      id: 'built-in.codeql-triage',
      source: 'built_in',
      automationKey: 'codeql_triage',
      title: 'Triage CodeQL Alerts',
      defaultScheduleMode: 'weekly',
      environmentPolicy: 'not_required',
      category: 'security',
      scoringRules: [
        {
          signal: 'codeql_alerts',
          weight: 10,
          explanation: (value) =>
            `Your repos have ${formatCount(value, 'open CodeQL alerts')}, and Roomote can handle those for you.`,
        },
      ],
    },
    {
      id: 'built-in.ci-failure-triage',
      source: 'built_in',
      automationKey: 'ci_failure_triage',
      title: 'CI Failure Triage',
      defaultScheduleMode: 'daily',
      environmentPolicy: 'optional',
      category: 'delivery',
      scoringRules: [
        {
          signal: 'ci_failures',
          weight: 9,
          explanation: (value) =>
            `Your repos have ${formatCount(value, 'recent CI failures')}, and Roomote can investigate and fix broken builds.`,
        },
      ],
    },
    {
      id: 'cookbook.scheduled-housekeeping',
      source: 'cookbook',
      cookbookSlug: 'scheduled-housekeeping',
      title: 'Schedule maintenance',
      template: {
        name: 'Repository maintenance review',
        prompt:
          'Review these repositories for dependency drift, stale feature flags, and flaky-test maintenance opportunities. Report only concrete, actionable findings with file paths and concise next steps.',
        scheduleMode: 'weekly',
        workspace: 'all_repositories',
        destination: 'none',
      },
      environmentPolicy: 'not_required',
      category: 'maintenance',
      scoringRules: [mergedPrRule(3), activePrRule(1)],
    },
  ] as const;

export type ScoredAutomationRecommendation = {
  candidate: AutomationRecommendationCandidate;
  score: number;
  explanation: string;
};

export function scoreAutomationRecommendations(
  signals: MergedAutomationRecommendationSignals,
  options: {
    enabledCandidateIds?: ReadonlySet<string>;
    catalog?: readonly AutomationRecommendationCandidate[];
    minScore?: number;
  } = {},
): ScoredAutomationRecommendation[] {
  const catalog = options.catalog ?? AUTOMATION_RECOMMENDATION_CATALOG;
  const enabled = options.enabledCandidateIds ?? new Set<string>();
  // Recommendations should still be useful immediately after a repository is
  // connected, before provider signal collection has produced rich data. Once
  // collection is complete, only recommend candidates backed by real signals.
  const allowFallbackCandidates = signals.partial !== false;
  const scored = catalog
    .filter((candidate) => !enabled.has(candidate.id))
    .filter((candidate) => {
      if (candidate.source !== 'built_in') return true;
      const descriptor = getTriggerableBackgroundAutomationDescriptorByKey(
        candidate.automationKey === 'review_code'
          ? 'conflict_resolver'
          : candidate.automationKey,
      );
      return candidate.automationKey === 'review_code'
        ? signals.sourceControlProviders.some((provider) =>
            sourceControlProviders.includes(provider),
          )
        : (descriptor?.supportedSourceControlProviders.some((provider) =>
            signals.sourceControlProviders.includes(provider),
          ) ?? false);
    })
    .map((candidate) => {
      const matches = candidate.scoringRules
        .map((rule) => ({ rule, value: signalValue(signals, rule.signal) }))
        .filter(({ value }) => value > 0);
      const score = matches.reduce(
        (total, { rule, value }) => total + rule.weight * Math.min(value, 20),
        0,
      );
      const explanation = matches[0]?.rule.explanation(
        matches[0].value,
        signals.repositoryCount,
      );
      return {
        candidate,
        score: score || (allowFallbackCandidates ? 1 : 0),
        explanation:
          explanation ?? fallbackRecommendationExplanation(candidate),
      };
    })
    .filter(({ score }) => score >= (options.minScore ?? 1))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.id.localeCompare(right.candidate.id),
    );

  const categories = new Map<RecommendationCategory, number>();
  const selected: ScoredAutomationRecommendation[] = [];
  for (const recommendation of scored) {
    const count = categories.get(recommendation.candidate.category) ?? 0;
    if (count >= 2) continue;
    categories.set(recommendation.candidate.category, count + 1);
    selected.push(recommendation);
    if (selected.length === 6) break;
  }

  if (selected.length < 3 && allowFallbackCandidates) {
    for (const recommendation of scored) {
      if (
        selected.some(
          (item) => item.candidate.id === recommendation.candidate.id,
        )
      )
        continue;
      selected.push(recommendation);
      if (selected.length === 3) break;
    }
  }

  return selected;
}
