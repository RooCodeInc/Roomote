const { submitPlatformIssueToPingMock } = vi.hoisted(() => ({
  submitPlatformIssueToPingMock: vi.fn(),
}));

vi.mock('@roomote/telemetry/server', () => ({
  submitPlatformIssueToPing: submitPlatformIssueToPingMock,
}));

import {
  db,
  eq,
  taskFactory,
  taskPlatformIssueReports,
  taskRuns,
  tasks,
  userFactory,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import {
  getPlatformIssueReportCommand,
  submitPlatformIssueReportCommand,
} from './platform-issue-reports';

const REPORT_ID = '5f55b5ee-7099-4ff2-b995-f39feb9c8eb0';
const TASK_ID = 'platform-issue-submission-command-test';

describe('platform issue report commands', () => {
  let adminId: string;

  beforeEach(async () => {
    process.env.R_APP_URL = 'https://app.example.com';
    submitPlatformIssueToPingMock.mockReset().mockResolvedValue(true);
    const admin = await userFactory.create({ role: 'admin' });
    adminId = admin.id;
    await taskFactory.create({ id: TASK_ID });
    const [run] = await db
      .insert(taskRuns)
      .values({
        taskId: TASK_ID,
        payloadKind: TaskPayloadKind.GithubPrReviewSync,
        payload: { repo: 'owner/repo' },
      })
      .returning({ id: taskRuns.id });
    await db.insert(taskPlatformIssueReports).values({
      id: REPORT_ID,
      taskId: TASK_ID,
      runId: run!.id,
      report: { title: 'Worker cannot start', summary: 'Detailed report' },
    });
  });

  afterEach(async () => {
    await db
      .delete(taskPlatformIssueReports)
      .where(eq(taskPlatformIssueReports.id, REPORT_ID));
    await db.delete(tasks).where(eq(tasks.id, TASK_ID));
  });

  it('reveals the report only to an authenticated admin', async () => {
    await expect(
      getPlatformIssueReportCommand({ isAdmin: false }, REPORT_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      getPlatformIssueReportCommand({ isAdmin: true }, REPORT_ID),
    ).resolves.toMatchObject({
      id: REPORT_ID,
      title: 'Worker cannot start',
      summary: 'Detailed report',
      taskUrl: expect.stringContaining(`/task/${TASK_ID}`),
      submittedAt: null,
    });
  });

  it('submits once and persists the confirming admin', async () => {
    const auth = { userId: adminId, isAdmin: true };

    await expect(
      submitPlatformIssueReportCommand(auth, REPORT_ID),
    ).resolves.toMatchObject({ success: true, submittedAt: expect.any(Date) });
    await expect(
      submitPlatformIssueReportCommand(auth, REPORT_ID),
    ).resolves.toMatchObject({ success: true, submittedAt: expect.any(Date) });

    expect(submitPlatformIssueToPingMock).toHaveBeenCalledTimes(1);
    expect(submitPlatformIssueToPingMock).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      report: {
        title: 'Worker cannot start',
        summary: 'Detailed report',
        taskUrl: expect.stringContaining(`/task/${TASK_ID}`),
      },
    });
    await expect(
      db.query.taskPlatformIssueReports.findFirst({
        where: eq(taskPlatformIssueReports.id, REPORT_ID),
        columns: { pingSubmittedAt: true, pingSubmittedByUserId: true },
      }),
    ).resolves.toMatchObject({
      pingSubmittedAt: expect.any(Date),
      pingSubmittedByUserId: adminId,
    });
  });

  it('keeps the report retryable when Ping does not accept it', async () => {
    submitPlatformIssueToPingMock.mockResolvedValue(false);

    await expect(
      submitPlatformIssueReportCommand(
        { userId: adminId, isAdmin: true },
        REPORT_ID,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Roomote could not receive this report. Please try again.',
    });
    await expect(
      db.query.taskPlatformIssueReports.findFirst({
        where: eq(taskPlatformIssueReports.id, REPORT_ID),
        columns: { pingSubmittedAt: true, pingSubmittedByUserId: true },
      }),
    ).resolves.toMatchObject({
      pingSubmittedAt: null,
      pingSubmittedByUserId: null,
    });
  });
});
