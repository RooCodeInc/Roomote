'use client';

import { NotepadText, Switch } from '@/components/system';
import { useResultsPage } from '@/hooks/useResultsPage';

import { Section } from './Section';

export function ResultsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } = useResultsPage();

  return (
    <Section icon={NotepadText} title="Results">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Results"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Show a Results tab where you can review automation reports and
          suggested follow-ups, then clear them or start new work.
        </p>
      </div>
    </Section>
  );
}
