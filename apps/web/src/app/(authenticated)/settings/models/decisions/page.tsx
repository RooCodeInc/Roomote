import { notFound } from 'next/navigation';

import { JudgmentDecisionTesterPage } from '@/components/settings/pages/JudgmentDecisionTesterPage';
import { authorize } from '@/lib/server/auth-context';

export default async function Page() {
  const authorizedUser = await authorize();
  if (!authorizedUser.success || !authorizedUser.isAdmin) {
    return notFound();
  }

  return <JudgmentDecisionTesterPage />;
}
