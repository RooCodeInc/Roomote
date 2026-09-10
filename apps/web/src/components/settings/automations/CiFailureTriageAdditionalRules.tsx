'use client';

import type { ReactNode } from 'react';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';
import { Label, Textarea } from '@/components/system';

export function AutomationAdditionalRules({
  automationKey = 'ci_failure_triage',
  value,
  onChange,
  error,
  globalDestination,
}: {
  automationKey?: TriggerableBackgroundAutomationKey;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  globalDestination: ReactNode;
}) {
  const automation =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);
  const descriptor =
    automation && 'additionalRules' in automation
      ? automation.additionalRules
      : null;
  if (!descriptor) return globalDestination;
  const fieldId = `${automationKey.replaceAll('_', '-')}-additional-rules`;

  return (
    <div className="space-y-4">
      {globalDestination}
      <div className="space-y-2">
        <Label htmlFor={fieldId}>Additional rules (optional)</Label>
        <Textarea
          id={fieldId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={8000}
          placeholder={descriptor.placeholder}
          aria-describedby={`${fieldId}-help`}
          aria-invalid={Boolean(error)}
        />
        <p id={`${fieldId}-help`} className="text-sm text-muted-foreground">
          Describe repository scope, report destinations, or workflow guidance.
          Leave blank to {descriptor.defaultScopeDescription} using the
          destination above. Rules are checked when you save.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
