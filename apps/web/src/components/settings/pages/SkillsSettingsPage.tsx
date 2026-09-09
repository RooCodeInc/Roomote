'use client';

import { useState } from 'react';
import { EnvironmentSkills } from '@/components/settings/EnvironmentSkills';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { InstanceSkills } from '@/components/settings/InstanceSkills';
import { useAuthorizedUser } from '@/hooks/useUser';
import { Button, Plus } from '@/components/system';

export function SkillsSettingsPage() {
  const { isAdmin } = useAuthorizedUser();
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
      {isAdmin ? <EnvironmentSkills /> : null}
    </SettingsShell>
  );
}
