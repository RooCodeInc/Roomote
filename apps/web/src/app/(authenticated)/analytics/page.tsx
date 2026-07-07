import { notFound } from 'next/navigation';

import { authorize } from '@/lib/server/auth-context';

import { Analytics } from './Analytics';

export default async function Page() {
  const authorizedUser = await authorize();

  if (!authorizedUser.success) {
    notFound();
  }

  return <Analytics />;
}
