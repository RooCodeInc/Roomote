import { notFound } from 'next/navigation';

import { SkillsSettingsPage } from '@/components/settings/pages/SkillsSettingsPage';
import { authorize } from '@/lib/server/auth-context';

export default async function Page() {
  const authorizedUser = await authorize();
  if (!authorizedUser.success || !authorizedUser.isAdmin) {
    return notFound();
  }

  return <SkillsSettingsPage />;
}
