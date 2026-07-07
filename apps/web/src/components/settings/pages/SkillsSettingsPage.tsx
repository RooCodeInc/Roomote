'use client';

import { CustomSkills } from '@/components/settings/CustomSkills';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function SkillsSettingsPage() {
  return (
    <SettingsShell pageId="skills" adminOnly={true}>
      <CustomSkills />
    </SettingsShell>
  );
}
