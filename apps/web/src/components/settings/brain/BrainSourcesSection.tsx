'use client';

import { Section } from '@/components/settings';
import { BasicTooltip, RadioTower } from '@/components/system';
import { cn } from '@/lib/utils';

import type {
  BrainSourceStatus,
  BrainSourceSummary,
} from '@/trpc/commands/brain';
import { describeSourceStatus } from './brain-presentation';

function SourceStatusIndicator({ status }: { status: BrainSourceStatus }) {
  const presentation = describeSourceStatus(status);

  return (
    <BasicTooltip content={presentation.label}>
      <span
        role="status"
        aria-label={presentation.label}
        tabIndex={0}
        className="absolute top-4 right-4 inline-flex size-2 cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span
          className={cn('size-2 rounded-full', presentation.dotClassName)}
        />
      </span>
    </BasicTooltip>
  );
}

function SourceRow({ source }: { source: BrainSourceSummary }) {
  return (
    <div className="relative space-y-2 rounded-lg border bg-background/40 p-4">
      <SourceStatusIndicator status={source.status} />

      <span className="font-medium">{source.label}</span>

      <p className="text-sm text-muted-foreground">{source.description}</p>
    </div>
  );
}

export function BrainSourcesSection({
  sources,
}: {
  sources: BrainSourceSummary[];
}) {
  const connectedSources = sources.filter(
    (source) => source.status !== 'not_connected',
  );

  return (
    <Section icon={RadioTower} title="Sources">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {connectedSources.map((source) => (
          <SourceRow key={source.id} source={source} />
        ))}
      </div>
    </Section>
  );
}
