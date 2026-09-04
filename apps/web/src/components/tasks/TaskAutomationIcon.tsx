import Image from 'next/image';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  type BackgroundAutomationKey,
} from '@roomote/types';

type TaskAutomationIconProps = {
  automationKey: string | null;
  className?: string;
};

const AUTOMATION_ICON_ASSETS: Partial<Record<BackgroundAutomationKey, string>> =
  {
    review_code: 'git-pull-request',
    call_roomote_via_emoji: 'smile',
    slack_channel_auto_start: 'messages-square',
    platform_issue_alerts: 'bell-electric',
  };

export function TaskAutomationIcon({
  automationKey,
  className,
}: TaskAutomationIconProps) {
  const descriptor = automationKey
    ? getTriggerableBackgroundAutomationDescriptorByKey(
        automationKey as BackgroundAutomationKey,
      )
    : null;

  const icon =
    descriptor?.slackIcon ??
    (automationKey
      ? AUTOMATION_ICON_ASSETS[automationKey as BackgroundAutomationKey]
      : undefined) ??
    'zap';

  return (
    <Image
      src={`/automation-icons/${icon}.png`}
      width={96}
      height={96}
      alt=""
      className={className}
    />
  );
}
