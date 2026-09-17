import { TRPCError } from '@trpc/server';
import {
  and,
  db,
  eq,
  isNull,
  taskPlatformIssueReports,
} from '@roomote/db/server';
import { submitPlatformIssueToPing } from '@roomote/telemetry/server';
import { buildPlatformIssueSourceUrl } from '@roomote/sdk/server/platform-issue-reporting';

import type { UserAuthSuccess } from '@/types';

function requireAdmin(auth: Pick<UserAuthSuccess, 'isAdmin'>) {
  if (!auth.isAdmin) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
  }
}

function getReportSource(report: {
  taskId: string | null;
  sessionId: string | null;
}) {
  if (report.taskId) return { taskId: report.taskId } as const;
  if (report.sessionId) return { sessionId: report.sessionId } as const;
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
}

export async function getPlatformIssueReportCommand(
  auth: Pick<UserAuthSuccess, 'isAdmin'>,
  reportId: string,
) {
  requireAdmin(auth);
  const report = await db.query.taskPlatformIssueReports.findFirst({
    where: eq(taskPlatformIssueReports.id, reportId),
    columns: {
      id: true,
      taskId: true,
      sessionId: true,
      report: true,
      pingSubmittedAt: true,
    },
  });

  if (!report) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
  }

  return {
    id: report.id,
    title: report.report.title,
    summary: report.report.summary,
    sourceLabel: report.taskId ? ('task' as const) : ('session' as const),
    taskUrl: buildPlatformIssueSourceUrl(
      getReportSource(report),
      'platform_issue_submission',
    ),
    submittedAt: report.pingSubmittedAt,
  };
}

export async function submitPlatformIssueReportCommand(
  auth: Pick<UserAuthSuccess, 'userId' | 'isAdmin'>,
  reportId: string,
) {
  requireAdmin(auth);
  const report = await db.query.taskPlatformIssueReports.findFirst({
    where: eq(taskPlatformIssueReports.id, reportId),
    columns: {
      id: true,
      taskId: true,
      sessionId: true,
      report: true,
      pingSubmittedAt: true,
    },
  });

  if (!report) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
  }
  if (report.pingSubmittedAt) {
    return { success: true as const, submittedAt: report.pingSubmittedAt };
  }

  const accepted = await submitPlatformIssueToPing({
    reportId: report.id,
    report: {
      ...report.report,
      taskUrl: buildPlatformIssueSourceUrl(
        getReportSource(report),
        'platform_issue_submission',
      ),
    },
  });

  if (!accepted) {
    return {
      success: false as const,
      error: 'Roomote could not receive this report. Please try again.',
    };
  }

  const submittedAt = new Date();
  await db
    .update(taskPlatformIssueReports)
    .set({
      pingSubmittedAt: submittedAt,
      pingSubmittedByUserId: auth.userId,
    })
    .where(
      and(
        eq(taskPlatformIssueReports.id, report.id),
        isNull(taskPlatformIssueReports.pingSubmittedAt),
      ),
    );

  return { success: true as const, submittedAt };
}
