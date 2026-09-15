'use client';

import { Lightbulb, Switch } from '@/components/system';
import { useHomeComposerSuggestions } from '@/hooks/useHomeComposerSuggestions';

import { Section } from './Section';

export function HomeComposerSuggestionsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useHomeComposerSuggestions();

  return (
    <Section icon={Lightbulb} title="Home suggestions">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Home suggestions"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Suggest personalized tasks on Home based on your recent completed
          work.
        </p>
      </div>
    </Section>
  );
}
