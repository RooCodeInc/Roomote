'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MAX_WORKSPACE_ROUTING_GUIDANCE_LENGTH } from '@roomote/types';
import {
  Button,
  GitBranch,
  Label,
  Skeleton,
  Textarea,
} from '@/components/system';
import { Section } from '@/components/settings';
import {
  useUpdateWorkspaceRoutingSettings,
  useWorkspaceRoutingSettings,
} from '@/hooks/environments';

export function EnvironmentRoutingOverview() {
  const settings = useWorkspaceRoutingSettings();
  const updateSettings = useUpdateWorkspaceRoutingSettings();
  const [guidance, setGuidance] = useState('');
  const [savedGuidance, setSavedGuidance] = useState('');

  useEffect(() => {
    const nextGuidance = settings.data?.guidance ?? '';
    setGuidance(nextGuidance);
    setSavedGuidance(nextGuidance);
  }, [settings.data]);

  if (settings.isPending) {
    return (
      <Section icon={GitBranch} title="Routing Rules">
        <Skeleton className="h-48 w-full" />
      </Section>
    );
  }

  const isDirty = guidance !== savedGuidance;
  const footer = isDirty ? (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={updateSettings.isPending}
        onClick={() => setGuidance(savedGuidance)}
      >
        Reset
      </Button>
      <Button
        type="button"
        disabled={updateSettings.isPending}
        onClick={async () => {
          try {
            const result = await updateSettings.mutateAsync({ guidance });
            setGuidance(result.guidance);
            setSavedGuidance(result.guidance);
            toast.success('Routing guidance saved');
          } catch {
            toast.error('Failed to save routing guidance');
          }
        }}
      >
        {updateSettings.isPending ? 'Saving...' : 'Save'}
      </Button>
    </>
  ) : undefined;

  return (
    <Section icon={GitBranch} title="Routing Rules" footer={footer}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Describe how Roomote should choose environments and models. For
          example: “Use the Web environment for frontend work” or “Prefer Claude
          Sonnet for code reviews.” Explicit choices in a request always take
          priority.
        </p>
        <Label htmlFor="workspace-routing-guidance" className="sr-only">
          Routing guidance
        </Label>
        <Textarea
          id="workspace-routing-guidance"
          value={guidance}
          rows={10}
          maxLength={MAX_WORKSPACE_ROUTING_GUIDANCE_LENGTH}
          className="min-h-48"
          placeholder={
            'Use the Web environment for frontend work.\nPrefer Claude Sonnet for code reviews.'
          }
          disabled={updateSettings.isPending}
          onChange={(event) => setGuidance(event.target.value)}
        />
      </div>
    </Section>
  );
}
