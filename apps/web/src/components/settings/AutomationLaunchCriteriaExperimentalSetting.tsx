'use client';

import { Switch, Zap } from '@/components/system';
import { useAutomationLaunchCriteriaExperiment } from '@/hooks/useAutomationLaunchCriteriaExperiment';

import { Section } from './Section';

export function AutomationLaunchCriteriaExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useAutomationLaunchCriteriaExperiment();

  return (
    <Section icon={Zap} title="Custom automation launch criteria">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle custom automation launch criteria"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Allow custom automations to use plain-language and typed checks before
          a run starts.
        </p>
      </div>
    </Section>
  );
}
