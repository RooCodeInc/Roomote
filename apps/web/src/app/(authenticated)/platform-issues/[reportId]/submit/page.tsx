import { notFound } from 'next/navigation';
import { z } from 'zod';

import { authorize } from '@/lib/server/auth-context';
import { getPlatformIssueReportCommand } from '@/trpc/commands/platform-issue-reports';

import { PlatformIssueSubmission } from './PlatformIssueSubmission';

const reportIdSchema = z.string().uuid();

export default async function Page({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const [{ reportId }, auth] = await Promise.all([params, authorize()]);
  const parsedReportId = reportIdSchema.safeParse(reportId);

  if (!auth.success || !auth.isAdmin || !parsedReportId.success) {
    notFound();
  }

  try {
    const report = await getPlatformIssueReportCommand(
      auth,
      parsedReportId.data,
    );
    return <PlatformIssueSubmission report={report} />;
  } catch {
    notFound();
  }
}
