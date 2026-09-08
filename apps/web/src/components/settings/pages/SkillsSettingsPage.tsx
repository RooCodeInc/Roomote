'use client';

import { useState } from 'react';
import { CustomSkills } from '@/components/settings/CustomSkills';
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
        <Button onClick={() => setIsCreating(true)}>
          <Plus />
          Add Skill
        </Button>
      }
    >
      <InstanceSkills
        isCreating={isCreating}
        onCloseCreate={() => setIsCreating(false)}
      />
      {isAdmin ? <CustomSkills /> : null}
    </SettingsShell>
  );
}
