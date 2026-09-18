const { authorizeMock, getReportMock, notFoundMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  getReportMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('Not found');
  }),
}));

vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('@/trpc/commands/platform-issue-reports', () => ({
  getPlatformIssueReportCommand: getReportMock,
}));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('./PlatformIssueSubmission', () => ({
  PlatformIssueSubmission: () => null,
}));

import Page from './page';
import { PlatformIssueSubmission } from './PlatformIssueSubmission';

const REPORT_ID = '5f55b5ee-7099-4ff2-b995-f39feb9c8eb0';
const REPORT = {
  id: REPORT_ID,
  title: 'Worker cannot start',
  summary: 'Detailed report',
  taskUrl: 'https://app.example.com/task/task-1',
  submittedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getReportMock.mockResolvedValue(REPORT);
});

it('loads the confirmation for an authenticated admin', async () => {
  const auth = { success: true, userId: 'admin-1', isAdmin: true };
  authorizeMock.mockResolvedValue(auth);

  const result = await Page({
    params: Promise.resolve({ reportId: REPORT_ID }),
  });

  expect(result).toMatchObject({ type: PlatformIssueSubmission });
  expect(getReportMock).toHaveBeenCalledWith(auth, REPORT_ID);
  expect(notFoundMock).not.toHaveBeenCalled();
});

it.each([
  ['an unauthenticated visitor', { success: false }],
  ['a non-admin member', { success: true, userId: 'member-1', isAdmin: false }],
])('hides the report from %s', async (_case, auth) => {
  authorizeMock.mockResolvedValue(auth);

  await expect(
    Page({ params: Promise.resolve({ reportId: REPORT_ID }) }),
  ).rejects.toThrow('Not found');
  expect(getReportMock).not.toHaveBeenCalled();
});

it('rejects an invalid report id before lookup', async () => {
  authorizeMock.mockResolvedValue({
    success: true,
    userId: 'admin-1',
    isAdmin: true,
  });

  await expect(
    Page({ params: Promise.resolve({ reportId: 'not-a-uuid' }) }),
  ).rejects.toThrow('Not found');
  expect(getReportMock).not.toHaveBeenCalled();
});
