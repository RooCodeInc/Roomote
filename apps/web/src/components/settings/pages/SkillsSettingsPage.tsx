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
    <SettingsShell pageId="skills">
      <section className="space-y-4" aria-labelledby="shared-skills-heading">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="shared-skills-heading" className="text-lg font-semibold">
              Shared Skills
            </h2>
            <p className="text-sm text-muted-foreground">
              Reusable skills available across this instance.
            </p>
          </div>
          <Button size="sm" onClick={() => setIsCreating(true)}>
            <Plus />
            Add Skill
          </Button>
        </div>
        <InstanceSkills
          isCreating={isCreating}
          onCloseCreate={() => setIsCreating(false)}
        />
      </section>
      {isAdmin ? <CustomSkills /> : null}
    </SettingsShell>
  );
}
