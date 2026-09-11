'use client';

import { NotepadText, Switch } from '@/components/system';
import { useResultsPage } from '@/hooks/useResultsPage';

import { Section } from './Section';

export function ResultsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } = useResultsPage();

  return (
    <Section icon={NotepadText} title="Results">
      <Switch
        aria-label="Toggle Results"
        checked={enabled}
        disabled={isLoading || isUpdating}
        onCheckedChange={setEnabled}
      />
    </Section>
  );
}
