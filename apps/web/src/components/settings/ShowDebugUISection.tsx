'use client';

import { useShowDebugUI } from '@/hooks/useShowDebugUI';

import { Bug, Switch } from '@/components/system';

import { Section } from './Section';

export function ShowDebugUISection() {
  const {
    canUseDebugUI,
    isDebugUIVisible,
    isLoading,
    isUpdating,
    setDebugUIVisible,
  } = useShowDebugUI();

  if (!canUseDebugUI) {
    return null;
  }

  return (
    <Section icon={Bug} title="Show Debug UI">
      <div className="flex gap-2 items-center">
        <Switch
          aria-label="Toggle debug UI"
          checked={isDebugUIVisible}
          disabled={isLoading || isUpdating}
          onCheckedChange={setDebugUIVisible}
        />
        <p className="text-sm text-foreground">
          Reveal internal-only diagnostics and controls that stay hidden for
          normal users.
        </p>
      </div>
    </Section>
  );
}
