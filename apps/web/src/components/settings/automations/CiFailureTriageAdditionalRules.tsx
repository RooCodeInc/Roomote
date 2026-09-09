'use client';

import type { ReactNode } from 'react';
import { Label, Textarea } from '@/components/system';

export function CiFailureTriageAdditionalRules({
  value,
  onChange,
  error,
  globalDestination,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  globalDestination: ReactNode;
}) {
  return (
    <div className="space-y-4">
      {globalDestination}
      <div className="space-y-2">
        <Label htmlFor="ci-additional-rules">Additional rules (optional)</Label>
        <Textarea
          id="ci-additional-rules"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={8000}
          placeholder="Only triage backend and platform. Send platform failures to #platform-ci in our Engineering Slack workspace."
          aria-describedby="ci-additional-rules-help"
          aria-invalid={Boolean(error)}
        />
        <p
          id="ci-additional-rules-help"
          className="text-sm text-muted-foreground"
        >
          Describe repository scope, report destinations, or investigation
          guidance. Leave blank to triage all repositories using the destination
          above. Rules are checked when you save.
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
