'use client';

import { MessagesSquare, Switch } from '@/components/system';
import { useFastSessionCommunicationJevExperiment } from '@/hooks/useFastSessionCommunicationJevExperiment';

import { Section } from './Section';

export function FastSessionCommunicationJevExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useFastSessionCommunicationJevExperiment();

  return (
    <Section icon={MessagesSquare} title="Jev Session communication">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Jev Session communication"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Experimental deployment-wide control. Use Jev for high-confidence,
          low-risk task reports, blocked-input detection, redundant-update
          suppression, and evidenced completion reporting. Explicit steering,
          permissions, cancellation, lifecycle, and destructive actions stay on
          deterministic or regular-LLM paths.
        </p>
      </div>
    </Section>
  );
}
