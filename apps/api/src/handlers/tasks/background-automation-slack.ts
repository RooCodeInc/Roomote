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
  overflowLabel: string;
  fallbackLead: string;
};

type ScheduledSuggestionSurfaceConfig = {
  suggestionType:
    | 'suggested_tasks'
    | 'sentry_triage'
    | 'dependabot_triage'
    | 'codeql_triage'
    | 'security_auditor'
    | 'code_quality_auditor'
    | 'ci_failure_triage';
  summaryKind:
    | 'suggested_tasks'
    | 'sentry_triage'
    | 'dependabot_triage'
    | 'codeql_triage'
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
      overflowLabel: 'suggestion',
      fallbackLead: 'Suggested follow-up work:',
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
      overflowLabel: 'Sentry action',
      fallbackLead: 'Sentry issues worth addressing:',
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
      overflowLabel: 'dependency update',
      fallbackLead: 'Dependency updates worth applying:',
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
      overflowLabel: 'CodeQL finding',
      fallbackLead: 'CodeQL findings worth fixing:',
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
      overflowLabel: 'security item',
      fallbackLead: 'Security follow-ups worth addressing:',
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
      overflowLabel: 'code quality item',
      fallbackLead: 'Code quality improvements worth making:',
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
      overflowLabel: 'CI failure',
      fallbackLead: 'CI failures worth fixing:',
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
