'use client';

import { MessagesSquare, Switch } from '@/components/system';
import { useSlackPeerConversationsExperiment } from '@/hooks/useSlackPeerConversationsExperiment';

import { Section } from './Section';

export function SlackPeerConversationsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useSlackPeerConversationsExperiment();

  return (
    <Section icon={MessagesSquare} title="Peer conversations">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle peer conversations"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let Fast observe human-to-human discussion in established Slack and
          Discord threads while staying quiet unless addressed.
        </p>
      </div>
    </Section>
  );
}
