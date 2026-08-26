import type { UserAuthSuccess } from '@/types';

const { getSessionByIdMock, resolveTaskAccessMock } = vi.hoisted(() => ({
  getSessionByIdMock: vi.fn(),
  resolveTaskAccessMock: vi.fn(),
}));

vi.mock('@/lib/server/sessions', () => ({
  findAccessibleSession: vi.fn(),
  getSessionById: getSessionByIdMock,
  getSessionForTask: vi.fn(),
  getSessions: vi.fn(),
  getSessionTimeline: vi.fn(),
  listSessionPins: vi.fn(),
  setSessionPinned: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));
vi.mock('../tasks/by-id', () => ({
  resolveTaskByIdAccessCommand: resolveTaskAccessMock,
}));
vi.mock('@roomote/db/server', () => ({
  advanceSessionReadCursor: vi.fn(),
  db: {},
}));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));

import { getSessionByIdCommand } from './index';

describe('getSessionByIdCommand', () => {
  it('redacts execution details when Session access exceeds task access', async () => {
    getSessionByIdMock.mockResolvedValue({
      id: 'session-1',
      tasks: [
        {
          taskId: 'task-1',
          title: 'Private execution',
          latestRun: { id: 1, error: 'private error', result: {} },
          latestOutput: 'private output',
          inferenceCostMicroUsd: 123,
          artifacts: [{ id: 'artifact-1', path: 'private.txt' }],
          pullRequests: [{ id: 'pr-1', url: 'https://example.com/private' }],
        },
      ],
    });
    resolveTaskAccessMock.mockResolvedValue({ kind: 'not-found' });

    const result = await getSessionByIdCommand(
      { userId: 'user-1', isAdmin: false } as UserAuthSuccess,
      'session-1',
    );

    expect(result?.tasks[0]).toEqual(
      expect.objectContaining({
        canAccessDetails: false,
        latestRun: null,
        latestOutput: null,
        inferenceCostMicroUsd: 0,
        artifacts: [],
        pullRequests: [],
      }),
    );
  });
});
