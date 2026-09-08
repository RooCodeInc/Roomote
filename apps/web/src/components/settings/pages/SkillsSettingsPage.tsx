'use client';

import { CustomSkills } from '@/components/settings/CustomSkills';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { InstanceSkills } from '@/components/settings/InstanceSkills';
import { useAuthorizedUser } from '@/hooks/useUser';

export function SkillsSettingsPage() {
  const { isAdmin } = useAuthorizedUser();
  return (
    <SettingsShell pageId="skills">
      <InstanceSkills />
      {isAdmin ? (
        <section
          className="space-y-4"
          aria-labelledby="environment-skills-heading"
        >
          <div>
            <h2
              id="environment-skills-heading"
              className="text-lg font-semibold"
            >
              Environment skills
            </h2>
            <p className="text-sm text-muted-foreground">
              Admin-managed skills enabled in selected environments.
            </p>
          </div>
          <CustomSkills />
        </section>
      ) : null}
    </SettingsShell>
  );
}
