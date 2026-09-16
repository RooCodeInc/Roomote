import { TRPCError } from '@trpc/server';
import {
  and,
  db,
  eq,
  isNull,
  taskPlatformIssueReports,
} from '@roomote/db/server';
import { submitPlatformIssueToPing } from '@roomote/telemetry/server';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server/env';

function requireAdmin(auth: Pick<UserAuthSuccess, 'isAdmin'>) {
  if (!auth.isAdmin) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
  }
}

function buildTaskUrl(taskId: string): string {
  const url = new URL(`/task/${taskId}`, Env.R_APP_URL);
  url.searchParams.set('utm_source', 'platform_issue_submission');
  url.searchParams.set('utm_medium', 'web');
  return url.toString();
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
    taskUrl: buildTaskUrl(report.taskId),
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
      taskUrl: buildTaskUrl(report.taskId),
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
