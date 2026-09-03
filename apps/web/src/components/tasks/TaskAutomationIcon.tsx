import type { ComponentType } from 'react';
import Image from 'next/image';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  type BackgroundAutomationKey,
} from '@roomote/types';

import {
  BellElectric,
  Bot,
  GitPullRequest,
  MessagesSquare,
  Smile,
} from '@/components/system';

type TaskAutomationIconProps = {
  automationKey: string | null;
  className?: string;
};

const AUTOMATION_ICONS: Partial<
  Record<BackgroundAutomationKey, ComponentType<{ className?: string }>>
> = {
  review_code: GitPullRequest,
  call_roomote_via_emoji: Smile,
  slack_channel_auto_start: MessagesSquare,
  platform_issue_alerts: BellElectric,
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

  if (descriptor) {
    return (
      <Image
        src={`/automation-icons/${descriptor.slackIcon}.png`}
        width={96}
        height={96}
        alt=""
        className={className}
      />
    );
  }

  const Icon =
    (automationKey
      ? AUTOMATION_ICONS[automationKey as BackgroundAutomationKey]
      : undefined) ?? Bot;

  return <Icon className={className} />;
}
