'use client';

import { MessagesSquare, Switch } from '@/components/system';
import { useSessionTaskCommunicationTriageExperiment } from '@/hooks/useSessionTaskCommunicationTriageExperiment';

import { Section } from './Section';

export function SessionTaskCommunicationTriageExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useSessionTaskCommunicationTriageExperiment();

  return (
    <Section icon={MessagesSquare} title="Task communication triage">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle task communication triage"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Tasks started from a session share their ongoing work with that
          session, not just their explicit reports. The judgment model decides
          whether each update matters to the person who asked: the session tells
          them when the task needs them, finds something that changes the
          picture, or reaches something they can act on; steers the task when it
          drifts from what they asked; and otherwise stays quiet until the
          closeout. Requires a judgment model in Settings → Models.
        </p>
      </div>
    </Section>
  );
}
