import type { ReactNode } from 'react';
import type { ScheduleOnlyBackgroundAutomationFrequency } from '@roomote/types';

import type { LucideIcon } from '@/components/system';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  GitCommitVertical,
  SquarePen,
  Switch,
  TriangleAlert,
  Wrench,
} from '@/components/system';

type ScheduleOnlyAutomationControl =
  | {
      kind: 'schedule';
      scheduleOptions: Array<{
        value: ScheduleOnlyBackgroundAutomationFrequency;
        label: string;
      }>;
    }
  | {
      kind: 'toggle';
      enabledFrequency: ScheduleOnlyBackgroundAutomationFrequency;
      enabledLabel: string;
    };

type ScheduleOnlyAutomationUiDefinition = {
  description: string;
  details: readonly string[];
  icon: LucideIcon;
  control: ScheduleOnlyAutomationControl;
};

export const SCHEDULE_ONLY_AUTOMATION_UI_DEFINITIONS = {
  securityAuditor: {
    description:
      'Review recently merged PRs for concrete security issues and secure-by-default gaps.',
    details: [
      'Reviews merged PRs since the last run, posts only actionable security follow-up work to the selected Slack channel, and stays quiet when there were no merged PRs in the selected interval.',
      'Uses the installed `security-review` and `security-best-practices` skills to inspect each merged PR diff before suggesting work.',
    ],
    icon: TriangleAlert,
    control: {
      kind: 'schedule',
      scheduleOptions: [],
    },
  },
  codeQualityAuditor: {
    description:
      'Review recently merged PRs for maintainability, design, and readability issues worth follow-up work.',
    details: [
      'Reviews merged PRs since the last run, posts only actionable code quality follow-up work to the selected Slack channel, and stays quiet when there were no merged PRs in the selected interval.',
      'Pushes on maintainability, clarity, file bloat, spaghetti branching, abstraction quality, and wrong-layer logic rather than correctness or security bugs.',
    ],
    icon: SquarePen,
    control: {
      kind: 'schedule',
      scheduleOptions: [],
    },
  },
  ciFailureTriage: {
    description:
      'Investigate failed CI runs on each default branch the moment they happen, then reproduce and fix them automatically.',
    details: [],
    icon: Wrench,
    control: {
      kind: 'toggle',
      enabledFrequency: 'daily',
      enabledLabel: 'Investigate CI failures as they happen',
    },
  },
  issueFixer: {
    description:
      'When an issue is opened or reopened on GitHub, GitLab, or Gitea, investigate it and post a concrete implementation plan on the issue.',
    details: [
      'Runs immediately from the issue webhook — not on a daily or weekly batch schedule.',
      'Supports GitHub, GitLab, and Gitea issues. Azure DevOps work items and Bitbucket issues are not covered yet.',
      'Posts a plan only. It does not implement the fix or open a pull request automatically.',
      'Only repositories covered by a configured Roomote environment are eligible.',
    ],
    icon: Wrench,
    control: {
      kind: 'toggle',
      enabledFrequency: 'daily',
      enabledLabel: 'Triage issues as they happen',
    },
  },
  mergeAnnouncer: {
    description:
      'Summarize commits pushed to each active repository’s default branch and announce who pushed them.',
    details: [
      'Runs immediately from provider-deduplicated push webhooks, not on a daily or weekly batch schedule.',
      'Uses the helper model for a brief commit summary and posts through the configured automation destination or normal manager-channel fallback.',
    ],
    icon: GitCommitVertical,
    control: {
      kind: 'toggle',
      enabledFrequency: 'daily',
      enabledLabel: 'Announce default-branch pushes as they happen',
    },
  },
} as const satisfies Record<string, ScheduleOnlyAutomationUiDefinition>;

type ScheduleOnlyAutomationContentProps = {
  automationLabel: string;
  control: ScheduleOnlyAutomationControl;
  details: readonly string[];
  frequency: ScheduleOnlyBackgroundAutomationFrequency;
  isEnabled: boolean;
  disabled: boolean;
  fieldId: string;
  children?: ReactNode;
  onFrequencyChange: (
    frequency: ScheduleOnlyBackgroundAutomationFrequency,
  ) => void;
};

export function ScheduleOnlyAutomationContent({
  automationLabel,
  control,
  details,
  frequency,
  isEnabled,
  disabled,
  fieldId,
  children,
  onFrequencyChange,
}: ScheduleOnlyAutomationContentProps) {
  return (
    <div className="space-y-5">
      {control.kind === 'toggle' ? (
        <div className="flex items-center gap-3">
          <Switch
            id={fieldId}
            checked={frequency !== 'off'}
            onCheckedChange={(checked) =>
              onFrequencyChange(checked ? control.enabledFrequency : 'off')
            }
            aria-label={`${automationLabel} enabled`}
            disabled={disabled}
          />
          <label htmlFor={fieldId} className="text-sm text-muted-foreground">
            {control.enabledLabel}
          </label>
        </div>
      ) : (
        <Select
          value={frequency}
          onValueChange={(value) =>
            onFrequencyChange(
              value as ScheduleOnlyBackgroundAutomationFrequency,
            )
          }
        >
          <SelectTrigger
            id={fieldId}
            aria-label={`${automationLabel} schedule`}
            className="w-full md:w-56"
          >
            <SelectValue placeholder="Select a schedule" />
          </SelectTrigger>
          <SelectContent>
            {control.scheduleOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {isEnabled ? (
        <div className="space-y-3">
          {children}
          {details.map((detail) => (
            <p
              key={detail}
              className="text-xs text-muted-foreground md:max-w-160"
            >
              {detail}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
