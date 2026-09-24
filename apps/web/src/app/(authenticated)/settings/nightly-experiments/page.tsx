import { notFound } from 'next/navigation';

import { NightlyExperimentsPage } from '@/components/settings/pages/NightlyExperimentsPage';
import { authorize } from '@/lib/server/auth-context';

export default async function Page() {
  const authorizedUser = await authorize();
  if (
    !authorizedUser.success ||
    !authorizedUser.isAdmin ||
    authorizedUser.nightlyExperimentsEnabled !== true
  ) {
    return notFound();
  }

  return <NightlyExperimentsPage />;
}
