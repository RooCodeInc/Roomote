import {
  getScheduledSuggestionBackgroundAutomationDescriptor,
  getTriggerableBackgroundAutomationSettingsHash,
  type TaskSuggestionSource,
  type TriggerableBackgroundAutomationDescriptorItem,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';

type ScheduledSuggestionSummaryPromptConfig = {
  automationDescription: string;
  mainActionLine: string;
  highlightLabel: string;
  openerSignal: string;
  openerExamples: string[];
  overflowLabel: string;
  fallbackLead: string;
};

type ScheduledSuggestionSurfaceConfig = {
  suggestionType:
    | 'suggested_tasks'
    | 'sentry_triage'
    | 'dependabot_triage'
    | 'codeql_triage'
    | 'issue_fixer'
    | 'security_auditor'
    | 'code_quality_auditor'
    | 'ci_failure_triage';
  summaryKind:
    | 'suggested_tasks'
    | 'sentry_triage'
    | 'dependabot_triage'
    | 'codeql_triage'
    | 'issue_fixer'
    | 'security_auditor'
    | 'code_quality_auditor'
    | 'ci_failure_triage';
  actionFooterText: string;
  prompt: ScheduledSuggestionSummaryPromptConfig;
};

export type ScheduledSuggestionSlackConfig = {
  suggestionType: ScheduledSuggestionSurfaceConfig['suggestionType'];
  automationSettingsHash: string;
  actionFooterText: string;
  summaryKind: ScheduledSuggestionSurfaceConfig['summaryKind'];
  automationKey:
    | 'suggester'
    | 'sentry_triage'
    | 'dependabot_triage'
    | 'codeql_triage'
    | 'issue_fixer'
    | 'security_auditor'
    | 'code_quality_auditor'
    | 'ci_failure_triage';
  summaryPrompt: ScheduledSuggestionSummaryPromptConfig;
};

const SCHEDULED_SUGGESTION_SURFACE_CONFIG: Record<
  | 'suggester'
  | 'sentry_triage'
  | 'dependabot_triage'
  | 'codeql_triage'
  | 'issue_fixer'
  | 'security_auditor'
  | 'code_quality_auditor'
  | 'ci_failure_triage',
  ScheduledSuggestionSurfaceConfig
> = {
  suggester: {
    suggestionType: 'suggested_tasks',
    summaryKind: 'suggested_tasks',
    actionFooterText:
      "I pulled the most useful follow-up ideas into the thread for review.\nReact with a :thumbsup: on any idea and I'll start it.",
    prompt: {
      automationDescription: 'an automation that suggests follow-up work',
      mainActionLine: 'Summarize the main ideas worth doing.',
      highlightLabel: 'ideas worth doing',
      openerSignal: 'a quick sweep for worthwhile follow-up work',
      openerExamples: [
        'I went looking for follow-up work worth picking up next',
        'I did a sweep for high-leverage follow-ups, the kind that tend to get skipped but pay off',
        'I scanned for useful follow-up work we could knock out while it is still fresh',
      ],
      overflowLabel: 'suggestion',
      fallbackLead:
        'I went looking for follow-up work worth picking up next, and a few ideas stood out as worth doing now.',
    },
  },
  sentry_triage: {
    suggestionType: 'sentry_triage',
    summaryKind: 'sentry_triage',
    actionFooterText:
      'I pulled the most useful Sentry follow-ups into the thread for review.',
    prompt: {
      automationDescription: 'a Sentry triage automation',
      mainActionLine: 'Summarize the main actions worth taking.',
      highlightLabel: 'actions or findings',
      openerSignal: 'a Sentry scan or triage pass',
      openerExamples: [
        'I went through Sentry for errors that are actually hitting users rather than just adding noise',
        'I did a Sentry pass, sorting the real user-facing failures from the background noise',
        'I triaged the latest Sentry issues, watching for anything trending worse or newly spiking',
      ],
      overflowLabel: 'Sentry action',
      fallbackLead:
        'I went through Sentry for errors that are actually hitting users, and a few stood out as worth acting on now.',
    },
  },
  dependabot_triage: {
    suggestionType: 'dependabot_triage',
    summaryKind: 'dependabot_triage',
    actionFooterText:
      'I pulled the strongest update candidates into the thread for review.',
    prompt: {
      automationDescription: 'a Dependabot triage automation',
      mainActionLine: 'Summarize the dependency updates worth taking.',
      highlightLabel: 'dependency updates worth doing',
      openerSignal: 'a Dependabot alert triage pass',
      openerExamples: [
        'I went through the open Dependabot alerts for updates worth taking before they pile up',
        'I did a Dependabot pass, separating the low-risk updates we should just take from the noisier ones',
        'I triaged the current Dependabot alerts, watching for anything with real security exposure',
      ],
      overflowLabel: 'dependency update',
      fallbackLead:
        'I went through the open Dependabot alerts for updates worth taking now, and a few low-risk ones stood out.',
    },
  },
  codeql_triage: {
    suggestionType: 'codeql_triage',
    summaryKind: 'codeql_triage',
    actionFooterText:
      'I pulled the strongest CodeQL remediation candidates into the thread for review.',
    prompt: {
      automationDescription: 'a CodeQL triage automation',
      mainActionLine: 'Summarize the CodeQL findings worth fixing.',
      highlightLabel: 'CodeQL findings worth fixing',
      openerSignal: 'a CodeQL / code-scanning alert triage pass',
      openerExamples: [
        'I went through the open CodeQL alerts for security findings worth fixing before they pile up',
        'I did a CodeQL pass, separating the high-confidence insecure patterns from noisier static findings',
        'I triaged the current code-scanning alerts, watching for anything with real security exposure',
      ],
      overflowLabel: 'CodeQL finding',
      fallbackLead:
        'I went through the open CodeQL alerts for security findings worth fixing now, and a few stood out.',
    },
  },
  issue_fixer: {
    suggestionType: 'issue_fixer',
    summaryKind: 'issue_fixer',
    actionFooterText:
      'I pulled the strongest open-issue fix candidates into the thread for review.',
    prompt: {
      automationDescription: 'an Issue Fixer automation',
      mainActionLine: 'Summarize the open GitHub issues worth fixing.',
      highlightLabel: 'issues worth fixing',
      openerSignal: 'an open GitHub issue triage pass',
      openerExamples: [
        'I went through open GitHub issues for clear, high-confidence fixes worth picking up',
        'I did an issue pass, separating well-specified bugs from noisy discussion threads',
        'I triaged the current open issues, watching for tightly scoped work with clear acceptance criteria',
      ],
      overflowLabel: 'issue fix',
      fallbackLead:
        'I went through open GitHub issues for clear fixes worth taking now, and a few stood out.',
    },
  },
  security_auditor: {
    suggestionType: 'security_auditor',
    summaryKind: 'security_auditor',
    actionFooterText:
      'I pulled the highest-value security follow-ups into the thread for review.',
    prompt: {
      automationDescription: 'a security audit automation',
      mainActionLine: 'Summarize the security follow-up work worth doing.',
      highlightLabel: 'security findings or fixes worth doing',
      openerSignal: 'a security review of recently merged pull requests',
      openerExamples: [
        'I went through the latest merged PRs for security gaps that could have slipped past review',
        'I did a security pass over the recent merges, watching for anything that weakens our secure-by-default posture',
        'I audited the latest merged PRs for security issues worth fixing before they compound',
      ],
      overflowLabel: 'security item',
      fallbackLead:
        'I went through the latest merged PRs for security gaps that could have slipped past review, and a few follow-ups stood out as worth fixing now.',
    },
  },
  code_quality_auditor: {
    suggestionType: 'code_quality_auditor',
    summaryKind: 'code_quality_auditor',
    actionFooterText:
      'I pulled the highest-leverage code quality follow-ups into the thread for review.',
    prompt: {
      automationDescription: 'a code quality audit automation',
      mainActionLine:
        'Summarize the highest-leverage code quality improvements worth doing.',
      highlightLabel: 'code quality improvements worth doing',
      openerSignal: 'a code quality review of recently merged pull requests',
      openerExamples: [
        'I went through the latest merged PRs for maintainability problems before they harden into tech debt',
        'I did a code-quality pass over the recent merges, watching for structure that is getting harder to change',
        'I audited the latest merged PRs for the cleanups worth doing while they are still cheap',
      ],
      overflowLabel: 'code quality item',
      fallbackLead:
        'I went through the latest merged PRs for maintainability issues that get more expensive to fix later, and a few cleanups stood out as worth doing now.',
    },
  },
  ci_failure_triage: {
    suggestionType: 'ci_failure_triage',
    summaryKind: 'ci_failure_triage',
    actionFooterText:
      'Each fix runs as its own task and reports back here when it finishes.',
    prompt: {
      automationDescription: 'a CI failure triage automation',
      mainActionLine: 'Summarize the CI failures worth fixing.',
      highlightLabel: 'CI failures worth fixing',
      openerSignal: 'a scan of failed default-branch CI runs',
      openerExamples: [
        'I went through the failing CI runs on the default branch to find what is actually blocking people',
        'I did a CI failure pass, sorting the real breakages from the flaky reruns',
        'I triaged the latest default-branch CI failures, watching for anything keeping the branch red',
      ],
      overflowLabel: 'CI failure',
      fallbackLead:
        'I went through the failing default-branch CI runs for what is actually blocking people, and a few fixes stood out as worth doing now.',
    },
  },
};

function isScheduledSuggestionDescriptor(
  descriptor: TriggerableBackgroundAutomationDescriptorItem | null,
): descriptor is TriggerableBackgroundAutomationDescriptorItem & {
  scheduledSuggestionSource: TaskSuggestionSource;
} {
  return Boolean(descriptor && 'scheduledSuggestionSource' in descriptor);
}

function getScheduledSuggestionSurfaceConfig(
  automationKey: TriggerableBackgroundAutomationKey,
) {
  if (
    automationKey === 'suggester' ||
    automationKey === 'sentry_triage' ||
    automationKey === 'dependabot_triage' ||
    automationKey === 'codeql_triage' ||
    automationKey === 'issue_fixer' ||
    automationKey === 'security_auditor' ||
    automationKey === 'code_quality_auditor' ||
    automationKey === 'ci_failure_triage'
  ) {
    return SCHEDULED_SUGGESTION_SURFACE_CONFIG[automationKey];
  }

  return null;
}

export function resolveScheduledSuggestionSlackConfig(
  source: TaskSuggestionSource | undefined,
): ScheduledSuggestionSlackConfig {
  const descriptor =
    getScheduledSuggestionBackgroundAutomationDescriptor(source);

  if (!isScheduledSuggestionDescriptor(descriptor)) {
    throw new Error(
      `Missing scheduled suggestion automation descriptor for ${source ?? 'suggest_ideas'}.`,
    );
  }

  const automationSettingsHash = getTriggerableBackgroundAutomationSettingsHash(
    descriptor.automationKey,
  );
  const surfaceConfig = getScheduledSuggestionSurfaceConfig(
    descriptor.automationKey,
  );

  if (!automationSettingsHash || !surfaceConfig) {
    throw new Error(
      `Missing scheduled suggestion automation config for ${source ?? 'suggest_ideas'}.`,
    );
  }

  return {
    suggestionType: surfaceConfig.suggestionType,
    automationSettingsHash,
    actionFooterText: surfaceConfig.actionFooterText,
    summaryKind: surfaceConfig.summaryKind,
    automationKey:
      surfaceConfig.summaryKind === 'suggested_tasks'
        ? 'suggester'
        : surfaceConfig.summaryKind,
    summaryPrompt: surfaceConfig.prompt,
  };
}
