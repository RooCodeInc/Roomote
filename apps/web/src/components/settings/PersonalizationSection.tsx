'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  Button,
  Label,
  RotateCcw,
  Sparkles,
  Switch,
  Textarea,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';
import type { UserPersonalizationSettings } from '@/types/preferences';

import { Section } from './Section';

export function PersonalizationSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.preferences.getPersonalization.queryKey();
  const personalization = useQuery(
    trpc.preferences.getPersonalization.queryOptions(),
  );
  const [instructions, setInstructions] = useState('');

  useEffect(() => {
    if (personalization.data) {
      setInstructions(personalization.data.instructions);
    }
  }, [personalization.data]);

  const update = useMutation(
    trpc.preferences.updatePersonalization.mutationOptions({
      onSuccess: (settings) => {
        queryClient.setQueryData<UserPersonalizationSettings>(
          queryKey,
          settings,
        );
        setInstructions(settings.instructions);
      },
      onError: (error) => {
        toast.error(error.message);
        void queryClient.invalidateQueries({ queryKey });
      },
    }),
  );

  const settings = personalization.data;
  const isBusy = personalization.isPending || update.isPending;
  const hasChanges = settings?.instructions !== instructions;

  return (
    <Section icon={Sparkles} title="How to work with me">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="personalization-instructions">
            Personal instructions
          </Label>
          <Textarea
            id="personalization-instructions"
            value={instructions}
            disabled={isBusy}
            maxLength={8_000}
            rows={7}
            placeholder="For example: Keep answers concise, lead with a recommendation, and use examples when explaining unfamiliar concepts."
            onChange={(event) => setInstructions(event.target.value)}
          />
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <p>
              Used privately to tailor your conversations and tasks. It is not
              shared with other members or admins through Roomote&apos;s normal
              UI or API.
            </p>
            <span className="shrink-0">{instructions.length}/8,000</span>
          </div>
        </div>

        <div className="flex gap-3">
          <Switch
            aria-label="Learn from conversations"
            checked={settings?.learnFromConversations ?? true}
            disabled={isBusy || !settings || hasChanges}
            onCheckedChange={(learnFromConversations) => {
              if (!settings) return;
              update.mutate({
                expectedVersion: settings.version,
                learnFromConversations,
              });
            }}
          />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Learn from conversations
            </p>
            <p className="text-sm text-foreground">
              Save durable preferences you state and modest, revisable style
              patterns. Turning this off keeps your saved instructions active.
            </p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Personalization remains subject to your deployment&apos;s
          infrastructure access, backups, and retention policies. Roomote does
          not enrich it from public profiles or the web.
        </p>

        <div className="flex flex-wrap justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isBusy || !settings}
            onClick={() => {
              if (!settings) return;
              update.mutate(
                { expectedVersion: settings.version, reset: true },
                { onSuccess: () => toast.success('Personalization reset') },
              );
            }}
          >
            <RotateCcw /> Reset
          </Button>
          <Button
            type="button"
            disabled={isBusy || !settings || !hasChanges}
            onClick={() => {
              if (!settings) return;
              update.mutate(
                { expectedVersion: settings.version, instructions },
                {
                  onSuccess: () => toast.success('Personal instructions saved'),
                },
              );
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Section>
  );
}
