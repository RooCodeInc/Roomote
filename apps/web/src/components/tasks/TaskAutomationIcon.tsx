import type { ComponentType } from 'react';
import type { BackgroundAutomationKey } from '@roomote/types';

import {
  BellElectric,
  Bot,
  BrandIcon,
  ChartColumnIncreasing,
  GitMergeConflict,
  GitPullRequest,
  Lightbulb,
  Megaphone,
  MessagesSquare,
  Smile,
  SquarePen,
  TriangleAlert,
  Wrench,
} from '@/components/system';

type TaskAutomationIconProps = {
  automationKey: string | null;
  className?: string;
};

const AUTOMATION_ICONS: Partial<
  Record<BackgroundAutomationKey, ComponentType<{ className?: string }>>
> = {
  review_code: GitPullRequest,
  conflict_resolver: GitMergeConflict,
  suggester: Lightbulb,
  announcer: Megaphone,
  call_roomote_via_emoji: Smile,
  slack_channel_auto_start: MessagesSquare,
  manager_stats: ChartColumnIncreasing,
  platform_issue_alerts: BellElectric,
  issue_fixer: Wrench,
  security_auditor: TriangleAlert,
  code_quality_auditor: SquarePen,
  ci_failure_triage: Wrench,
};

export function TaskAutomationIcon({
  automationKey,
  className,
}: TaskAutomationIconProps) {
  if (automationKey === 'dependabot_triage') {
    return (
      <BrandIcon icon="dependabot" name="Dependabot" className={className} />
    );
  }

  if (automationKey === 'codeql_triage') {
    return <BrandIcon icon="github" name="CodeQL" className={className} />;
  }

  if (automationKey === 'sentry_triage') {
    return <BrandIcon icon="sentry" name="Sentry" className={className} />;
  }

  const Icon =
    (automationKey
      ? AUTOMATION_ICONS[automationKey as BackgroundAutomationKey]
      : undefined) ?? Bot;

  return <Icon className={className} />;
}
