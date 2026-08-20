'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';

import { Section } from '@/components/settings';
import {
  Badge,
  Button,
  Input,
  Loader2,
  Lock,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings2,
} from '@/components/system';
import { SETTINGS_PATHS } from '@/lib/settings';
import { useTRPC } from '@/trpc/client';

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
 * Sets the Brain's provider key from the page itself: the key lives in the
 * persisted deployment environment store, which survives fleet reprovisions
 * (a Railway-side variable would be reconciled away by the Cloud manager).
 * This is the whole opt-in for a managed Brain, so the form is the main
 * event in the needs-key state.
 */
function BrainProviderKeyForm({ onSaved }: { onSaved: () => void }) {
  const trpc = useTRPC();
  const [provider, setProvider] = useState<'openrouter' | 'openai'>(
    'openrouter',
  );
  const [key, setKey] = useState('');

  const save = useMutation(
    trpc.brain.setProviderKey.mutationOptions({
      onSuccess: () => {
        toast.success('Brain provider key saved');
        setKey('');
        onSaved();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <div className="flex w-full max-w-xl flex-wrap items-center gap-2">
      <Select
        value={provider}
        onValueChange={(value) => setProvider(value as typeof provider)}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="openrouter">OpenRouter</SelectItem>
          <SelectItem value="openai">OpenAI</SelectItem>
        </SelectContent>
      </Select>
      <Input
        secret={true}
        aria-label="Brain provider key"
        placeholder="Provider API key"
        className="min-w-48 flex-1"
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <Button
        size="sm"
        disabled={key.trim().length < 16 || save.isPending}
        onClick={() => save.mutate({ provider, key: key.trim() })}
      >
        {save.isPending ? <Loader2 className="animate-spin" /> : null}
        Save key
      </Button>
    </div>
  );
}

/**
 * What the Brain runs on. The models are read-only by design (the synthesis
 * model is an env override applied at forward time; the embedding model was
 * fixed when the Brain was created), while the provider key — the Brain's
 * actual opt-in — is editable right here.
 */
export function BrainConfigurationSection({
  settings,
}: {
  settings: BrainSettings;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [replacingKey, setReplacingKey] = useState(false);
  const providerLabel = settings.inferenceProvider
    ? BRAIN_INFERENCE_PROVIDER_LABELS[settings.inferenceProvider]
    : null;

  const onKeySaved = () => {
    setReplacingKey(false);
    void queryClient.invalidateQueries({
      queryKey: trpc.brain.get.queryKey(),
    });
  };

  return (
    <Section icon={Settings2} title="Configuration">
      <div className="space-y-4">
        {settings.needsKey ? (
          <ConfigRow
            label="Provider key"
            helper="Stored encrypted with the deployment settings, so it survives fleet upgrades. Saving it turns the Brain on."
          >
            <BrainProviderKeyForm onSaved={onKeySaved} />
          </ConfigRow>
        ) : (
          <>
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
                  {settings.models.embeddingDimensions.toLocaleString()}{' '}
                  dimensions
                </span>
              ) : null}
            </ConfigRow>

            <ConfigRow
              label="Inference key"
              helper="The Brain holds no provider credential. Every call routes through Roomote, so rotating the key applies on the next call with no restart."
            >
              {replacingKey ? (
                <BrainProviderKeyForm onSaved={onKeySaved} />
              ) : (
                <>
                  <span>
                    {providerLabel
                      ? settings.keySource === 'brain'
                        ? `Brain-specific ${providerLabel} key`
                        : `The deployment's ${providerLabel} key`
                      : 'No provider key resolves'}
                  </span>
                  <Link
                    className="text-secondary-foreground underline-offset-4 hover:underline"
                    href={SETTINGS_PATHS.models}
                  >
                    Manage in Models
                  </Link>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setReplacingKey(true)}
                  >
                    Replace key
                  </Button>
                </>
              )}
            </ConfigRow>
          </>
        )}
      </div>
    </Section>
  );
}
