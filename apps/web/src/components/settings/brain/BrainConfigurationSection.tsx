'use client';

import { Section } from '@/components/settings';
import { Badge, Lock, Settings2 } from '@/components/system';

import type { BrainSettings } from '@/trpc/commands/brain';
import { BRAIN_INFERENCE_PROVIDER_LABELS } from './brain-presentation';

function ConfigRow({
  label,
  children,
  helper,
}: {
  label: string;
  children: React.ReactNode;
  helper: string;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
      <span className="w-44 shrink-0 pt-0.5 text-sm font-medium">{label}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {children}
        </div>
        <p className="text-xs text-muted-foreground">{helper}</p>
      </div>
    </div>
  );
}

/**
 * What the Brain runs on, read-only by design. The provider key lives with
 * the other model credentials in Settings, the synthesis model is an env
 * override applied at forward time, and the embedding model was fixed when
 * the Brain was created. A page that displayed editable controls for values
 * it cannot change would be lying about where the levers are.
 */
export function BrainConfigurationSection({
  settings,
}: {
  settings: BrainSettings;
}) {
  const providerLabel = settings.inferenceProvider
    ? BRAIN_INFERENCE_PROVIDER_LABELS[settings.inferenceProvider]
    : null;

  return (
    <Section icon={Settings2} title="Configuration">
      <div className="space-y-4">
        <ConfigRow
          label="Synthesis model"
          helper="Answers synthesize queries across pages, on the deployment's inference key. Set R_BRAIN_MODEL to change it; changes apply immediately."
        >
          <code className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-xs">
            {settings.models?.synthesisModel ?? 'Not resolved'}
          </code>
          {settings.models?.synthesisSource === 'override' ? (
            <Badge variant="secondary">Override</Badge>
          ) : null}
        </ConfigRow>

        <ConfigRow
          label="Embedding model"
          helper="Fixed when this Brain was created. It sizes the vector store, and changing it requires a migration that re-embeds every page."
        >
          <Lock className="size-3.5 text-muted-foreground" />
          <code className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-xs">
            {settings.models?.embeddingModel ?? 'Not resolved'}
          </code>
          {settings.models?.embeddingDimensions ? (
            <span className="text-muted-foreground">
              {settings.models.embeddingDimensions.toLocaleString()} dimensions
            </span>
          ) : null}
        </ConfigRow>

        <ConfigRow
          label="Inference key"
          helper="The Brain holds no provider credential. Every call routes through Roomote, so rotating the key applies on the next call with no restart."
        >
          <span>
            {providerLabel
              ? settings.keySource === 'brain'
                ? `Brain-specific ${providerLabel} key`
                : `The deployment's ${providerLabel} key`
              : 'No provider key resolves'}
          </span>
        </ConfigRow>
      </div>
    </Section>
  );
}
