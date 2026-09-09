'use client';

import { useState } from 'react';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { InstanceSkills } from '@/components/settings/InstanceSkills';
import { Button, Plus } from '@/components/system';

export function SkillsSettingsPage() {
  const [isCreating, setIsCreating] = useState(false);
  return (
    <SettingsShell
      pageId="skills"
      showHeaderActionOnMobile
      headerAction={
        <Button size="sm" onClick={() => setIsCreating(true)}>
          <Plus className="size-4" />
          Add Skill
        </Button>
      }
    >
      <InstanceSkills
        isCreating={isCreating}
        onCloseCreate={() => setIsCreating(false)}
      />
    </SettingsShell>
  );
}
