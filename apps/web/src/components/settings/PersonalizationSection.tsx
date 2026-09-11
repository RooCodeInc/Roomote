'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  Button,
  Check,
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
            Things Roomote should always know about you to be more useful. Not
            shared with others.
          </Label>
          <Textarea
            id="personalization-instructions"
            value={instructions}
            disabled={isBusy}
            maxLength={8_000}
            rows={7}
            className="md:min-h-48"
            placeholder="For example: Keep answers concise, lead with a recommendation, and use examples when explaining unfamiliar concepts."
            onChange={(event) => setInstructions(event.target.value)}
          />
          <div className="flex justify-end text-xs text-muted-foreground">
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
              Disable if you don&apos;t want Roomote to learn automatically. Any
              content here will still be used.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap justify-start gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
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
            size="sm"
            disabled={isBusy || !settings || !hasChanges}
            onClick={() => {
              if (!settings) return;
              update.mutate(
                { expectedVersion: settings.version, instructions },
                {
                  onSuccess: () =>
                    toast.success(
                      "Personal instructions saved. They'll apply in your next new session.",
                    ),
                },
              );
            }}
          >
            <Check />
            Save
          </Button>
        </div>
      </div>
    </Section>
  );
}
