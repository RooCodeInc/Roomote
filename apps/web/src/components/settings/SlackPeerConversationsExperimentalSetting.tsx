'use client';

import { MessagesSquare, Switch } from '@/components/system';
import { useSlackPeerConversationsExperiment } from '@/hooks/useSlackPeerConversationsExperiment';

import { Section } from './Section';

export function SlackPeerConversationsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useSlackPeerConversationsExperiment();

  return (
    <Section icon={MessagesSquare} title="Slack peer conversations">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Let Fast observe human-to-human discussion in its Slack threads while
          staying quiet unless addressed.
        </p>
        <Switch
          aria-label="Toggle Slack peer conversations"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
      </div>
    </Section>
  );
}
