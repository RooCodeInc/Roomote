'use client';

import { Section } from '@/components/settings';
import { Activity } from '@/components/system';

import type { BrainSettings } from '@/trpc/commands/brain';
import {
  BRAIN_INFERENCE_PROVIDER_LABELS,
  describeBrainStatus,
} from './brain-presentation';

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5 min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium" title={value}>
        {value}
      </p>
    </div>
  );
}

export function BrainStatusSection({ settings }: { settings: BrainSettings }) {
  const status = describeBrainStatus(settings.status);

  return (
    <Section
      icon={Activity}
      title="Status"
      action={
        <span className="flex items-center gap-2 text-sm font-medium">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${status.dotClassName}`}
          />
          {status.label}
        </span>
      }
    >
      <p className="text-sm text-muted-foreground">
        {settings.statusDetail ??
          'Agents read the Brain before they start work, so what one task learns the next one already knows.'}
      </p>

      {settings.status !== 'not_configured' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Fact label="Endpoint" value={settings.url ?? 'Not set'} />
          <Fact
            label="Recall"
            value={
              settings.inferenceProvider ? 'Semantic + keyword' : 'Keyword only'
            }
          />
          <Fact
            label="Inference"
            value={
              settings.inferenceProvider
                ? (BRAIN_INFERENCE_PROVIDER_LABELS[
                    settings.inferenceProvider
                  ] ?? settings.inferenceProvider)
                : 'Not configured'
            }
          />
        </div>
      ) : null}
    </Section>
  );
}
