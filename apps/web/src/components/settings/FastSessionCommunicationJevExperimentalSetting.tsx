'use client';

import { MessagesSquare, Switch } from '@/components/system';
import { useFastSessionCommunicationJevExperiment } from '@/hooks/useFastSessionCommunicationJevExperiment';

import { Section } from './Section';

export function FastSessionCommunicationJevExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useFastSessionCommunicationJevExperiment();

  return (
    <Section icon={MessagesSquare} title="Real-time session/task communication">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle real-time session/task communication"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Send all task activity to the parent session and let it use the
          decision model to determine when to take action.
        </p>
      </div>
    </Section>
  );
}
