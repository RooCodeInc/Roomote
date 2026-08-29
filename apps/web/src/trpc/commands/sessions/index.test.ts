import type { UserAuthSuccess } from '@/types';

const { currentEpochSecondsMock, getSessionByIdMock } = vi.hoisted(() => ({
  currentEpochSecondsMock: vi.fn(),
  getSessionByIdMock: vi.fn(),
}));

vi.mock('@/lib/server/artifact-signature', () => ({
  currentEpochSeconds: currentEpochSecondsMock,
  signArtifactId: (artifactId: string, timestamp: number) =>
    `signature-${artifactId}-${timestamp}`,
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
vi.mock('@roomote/db/server', () => ({
  advanceSessionReadCursor: vi.fn(),
  db: {},
}));
vi.mock('@roomote/telemetry/server', () => ({ captureEvent: vi.fn() }));

import { getSessionByIdCommand } from './index';

describe('getSessionByIdCommand', () => {
  beforeEach(() => {
    currentEpochSecondsMock.mockReturnValue(7_201);
  });

  it('marks session tasks accessible without per-task access queries', async () => {
    // Session-level access is the gate (getSessionById's scope check);
    // getSessionTasks only returns live linked tasks, so the old per-task
    // access resolution was N+1 dead weight.
    getSessionByIdMock.mockResolvedValue({
      id: 'session-1',
      tasks: [
        {
          taskId: 'task-1',
          title: 'Execution',
          latestRun: { id: 1, error: null, result: {} },
          latestOutput: 'output',
          inferenceCostMicroUsd: 123,
          artifacts: [
            {
              id: 'artifact-1',
              path: 'diff.txt',
              contentType: 'text/plain',
            },
          ],
          pullRequests: [],
        },
      ],
    });

    const result = await getSessionByIdCommand(
      { userId: 'user-1', isAdmin: false } as UserAuthSuccess,
      'session-1',
    );

    expect(result?.tasks[0]).toEqual(
      expect.objectContaining({
        canAccessDetails: true,
        latestOutput: 'output',
        inferenceCostMicroUsd: 123,
      }),
    );
  });

  it('reuses signed thumbnail URLs within the cache window', async () => {
    getSessionByIdMock.mockResolvedValue({
      id: 'session-1',
      tasks: [
        {
          taskId: 'task-1',
          artifacts: [
            {
              id: 'artifact-image',
              path: 'screenshots/result.png',
              contentType: 'image/png',
            },
            {
              id: 'artifact-text',
              path: 'notes.txt',
              contentType: 'text/plain',
            },
          ],
        },
      ],
    });

    const firstResult = await getSessionByIdCommand(
      { userId: 'user-1', isAdmin: false } as UserAuthSuccess,
      'session-1',
    );
    currentEpochSecondsMock.mockReturnValue(7_399);
    const secondResult = await getSessionByIdCommand(
      { userId: 'user-1', isAdmin: false } as UserAuthSuccess,
      'session-1',
    );

    expect(firstResult?.tasks[0]?.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-image',
        thumbnailUrl:
          '/api/artifacts/artifact-image/raw?sig=signature-artifact-image-7200&ts=7200',
      }),
      expect.objectContaining({
        id: 'artifact-text',
        thumbnailUrl: undefined,
      }),
    ]);
    expect(secondResult?.tasks[0]?.artifacts).toEqual(
      firstResult?.tasks[0]?.artifacts,
    );
  });
});
