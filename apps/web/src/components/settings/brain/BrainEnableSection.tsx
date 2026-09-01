'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Section } from '@/components/settings';
import { BookOpenText, Switch } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import type { BrainSettings } from '@/trpc/commands/brain';

export function BrainEnableSection({ settings }: { settings: BrainSettings }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const brainQueryKey = trpc.brain.get.queryKey();

  const setEnabled = useMutation(
    trpc.brain.setMemoryEnabled.mutationOptions({
      onSuccess: ({ enabled }) => {
        void queryClient.invalidateQueries({ queryKey: brainQueryKey });
        toast.success(enabled ? 'Memory enabled.' : 'Memory disabled.');
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <Section icon={BookOpenText} title="Memory">
      <div className="flex gap-3">
        <Switch
          aria-label="Enable Memory"
          checked={settings.enabled}
          disabled={setEnabled.isPending}
          onCheckedChange={(checked) =>
            setEnabled.mutate({ enabled: checked === true })
          }
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">Enable Memory</div>
          <p className="text-sm text-muted-foreground">
            {settings.enabled
              ? 'Agents share one deployment-wide memory: completed tasks, pull requests, and connected sources are ingested, and agents recall them before they start.'
              : 'Memory is off. Agents are not told it exists and nothing is ingested. Sources hold their position, so turning it back on resumes where they left off.'}
          </p>
        </div>
      </div>
    </Section>
  );
}
