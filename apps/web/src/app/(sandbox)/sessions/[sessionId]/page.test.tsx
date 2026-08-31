import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const {
  authorizeMock,
  getFastSessionByIdMock,
  getFastSessionTasksMock,
  getSessionByIdCommandMock,
  transcriptMock,
  sessionWorkspaceMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  getFastSessionByIdMock: vi.fn(),
  getFastSessionTasksMock: vi.fn(),
  getSessionByIdCommandMock: vi.fn(),
  transcriptMock: vi.fn(
    ({ footer }: { messages: unknown[]; footer?: ReactNode }) => (
      <div data-testid="transcript">{footer}</div>
    ),
  ),
  sessionWorkspaceMock: vi.fn(({ children }: { children: ReactNode }) => (
    <main data-testid="workspace-surface">{children}</main>
  )),
}));

vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/server/fast-sessions', () => ({
  getFastSessionById: getFastSessionByIdMock,
  getFastSessionTasks: getFastSessionTasksMock,
}));
vi.mock('@/trpc/commands/sessions', () => ({
  getSessionByIdCommand: getSessionByIdCommandMock,
}));
vi.mock('../../use-sandbox-layout', () => ({
  useResponsiveSandboxSidebar: vi.fn(),
  useSandboxLayout: () => ({
    isSidebarVisible: true,
    setSidebarVisible: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));
vi.mock('@/components/layout', () => ({
  WorkspaceHeader: ({ children }: { children: ReactNode }) => (
    <header data-testid="workspace-header">{children}</header>
  ),
  WorkspaceSurface: ({ children }: { children: ReactNode }) => (
    <main data-testid="workspace-surface">{children}</main>
  ),
}));
vi.mock('./FastSessionTranscript', () => ({
  FastSessionTranscript: transcriptMock,
}));
vi.mock('./SessionWorkspace', () => ({
  SessionWorkspace: sessionWorkspaceMock,
  SessionHeaderExtras: ({ status }: { status: string | null }) => (
    <div data-testid="session-header-extras">{status}</div>
  ),
}));
vi.mock('./SessionReadTracker', () => ({
  SessionReadTracker: () => null,
}));

import SessionDetailPage, { generateMetadata } from './page';

describe('Session detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionByIdCommandMock.mockResolvedValue(null);
    getFastSessionTasksMock.mockResolvedValue([]);
  });

  it('uses the Session title in the initial route metadata', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    getSessionByIdCommandMock.mockResolvedValue({
      id: '6a1f8f1e-0000-4000-8000-000000000006',
      title:
        'Rotate the API keys across every production environment without downtime',
      fastConversationId: null,
    });

    await expect(
      generateMetadata({
        params: Promise.resolve({
          sessionId: '6a1f8f1e-0000-4000-8000-000000000006',
        }),
      }),
    ).resolves.toEqual({
      title:
        'Rotate the API keys across every production environment with... | Roomote',
    });
  });

  it('uses the shared task workspace and renders supported session data', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    getFastSessionByIdMock.mockResolvedValue({
      id: '6a1f8f1e-0000-4000-8000-000000000001',
      userId: 'user-1',
      ownerName: 'User',
      ownerEmail: 'user@example.com',
      surface: 'slack',
      workspaceId: 'workspace-1',
      conversationId: '1787748111.947499',
      currentReplyChannelId: 'channel-1',
      currentReplyThreadId: 'thread-1',
      replyTargetVerified: true,
      openCodeSessionId: 'opencode-1',
      messageCount: 2,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      messages: [
        {
          id: 'message-1',
          eventId: 'turn-1:user',
          turnId: 'turn-1',
          turnSeq: 0,
          ts: 1,
          eventType: 'roomote_runtime.user_prompt',
          role: 'user',
          contentBlocks: [{ type: 'text', text: 'Question' }],
          metadata: { visibleInTranscript: true },
          payload: {},
          source: 'slack',
          nativeSessionId: null,
          nativeMessageId: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'message-2',
          eventId: 'turn-1:assistant:0',
          turnId: 'turn-1',
          turnSeq: 1,
          ts: 2,
          eventType: 'roomote_runtime.assistant_message',
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: 'Answer' }],
          metadata: { visibleInTranscript: true },
          payload: {},
          source: 'slack',
          nativeSessionId: 'opencode-1',
          nativeMessageId: null,
          createdAt: new Date('2026-01-01T00:00:01.000Z'),
        },
      ],
    });

    const html = renderToStaticMarkup(
      await SessionDetailPage({
        params: Promise.resolve({
          sessionId: '6a1f8f1e-0000-4000-8000-000000000001',
        }),
      }),
    );

    expect(html).toContain('data-testid="workspace-surface"');
    expect(html).not.toContain('Delegated tasks');
    expect(html).not.toContain('Session context');
    expect(html).not.toContain('OpenCode workspace details unavailable');
    expect(transcriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '6a1f8f1e-0000-4000-8000-000000000001',
        canReply: true,
        fallbackTitle: 'Question',
        initialMessages: expect.arrayContaining([
          expect.objectContaining({ eventId: 'turn-1:user' }),
        ]),
      }),
      undefined,
    );
  });

  it('enables the reply composer for web-surface sessions', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    getFastSessionByIdMock.mockResolvedValue({
      id: '6a1f8f1e-0000-4000-8000-000000000003',
      userId: 'user-1',
      ownerName: 'User',
      ownerEmail: 'user@example.com',
      title: 'Rotate the API keys',
      surface: 'web',
      workspaceId: 'user-1',
      conversationId: 'b3b0a53e-6dab-4bb8-b3a5-111111111111',
      currentReplyChannelId: null,
      currentReplyThreadId: null,
      replyTargetVerified: true,
      openCodeSessionId: null,
      messageCount: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      messages: [],
    });

    const html = renderToStaticMarkup(
      await SessionDetailPage({
        params: Promise.resolve({
          sessionId: '6a1f8f1e-0000-4000-8000-000000000003',
        }),
      }),
    );

    expect(html).not.toContain('b3b0a53e-6dab-4bb8-b3a5-111111111111');
    expect(transcriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '6a1f8f1e-0000-4000-8000-000000000003',
        canReply: true,
        initialTitle: 'Rotate the API keys',
        fallbackTitle: 'New session',
      }),
      undefined,
    );
  });

  it('hydrates a direct Session route without seeding the response lease', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    getSessionByIdCommandMock.mockResolvedValue({
      id: '6a1f8f1e-0000-4000-8000-000000000002',
      title: 'Session title',
      ownerName: 'User',
      ownerEmail: 'user@example.com',
      ownerImageUrl: null,
      sourceSurface: 'slack',
      fastConversationId: '6a1f8f1e-0000-4000-8000-000000000005',
      directInferenceCostMicroUsd: 100_000,
      inferenceCostMicroUsd: 300_000,
      respondingUntil: new Date(Date.now() + 60_000),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'active',
      tasks: [
        {
          taskId: 'task-1',
          title: 'Delegated task',
          inferenceCostMicroUsd: 200_000,
        },
      ],
    });
    getFastSessionByIdMock.mockResolvedValue({
      id: '6a1f8f1e-0000-4000-8000-000000000005',
      ownerName: 'User',
      ownerEmail: 'user@example.com',
      surface: 'slack',
      model: null,
      reasoningEffort: null,
      inferenceCostMicroUsd: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      messages: [],
      hasOlderMessages: false,
    });

    renderToStaticMarkup(
      await SessionDetailPage({
        params: Promise.resolve({
          sessionId: '6a1f8f1e-0000-4000-8000-000000000002',
        }),
      }),
    );

    expect(getSessionByIdCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      '6a1f8f1e-0000-4000-8000-000000000002',
    );
    expect(getFastSessionByIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      '6a1f8f1e-0000-4000-8000-000000000005',
    );
    expect(getFastSessionTasksMock).not.toHaveBeenCalled();
    expect(sessionWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          id: '6a1f8f1e-0000-4000-8000-000000000002',
          status: 'active',
          tasks: [expect.objectContaining({ taskId: 'task-1' })],
          inferenceCostMicroUsd: 300_000,
          inferenceCostBreakdown: {
            directInferenceCostMicroUsd: 100_000,
            tasks: [
              expect.objectContaining({
                taskId: 'task-1',
                inferenceCostMicroUsd: 200_000,
              }),
            ],
          },
        }),
      }),
      undefined,
    );
    expect(transcriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '6a1f8f1e-0000-4000-8000-000000000005',
        canReply: true,
        initialTitle: 'Session title',
        fallbackTitle: 'Session title',
      }),
      undefined,
    );
    expect(transcriptMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'initialConversationResponding',
    );
    expect(transcriptMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'timelineExtras',
    );
  });

  it('renders a task-only workspace for unified sessions without a Fast conversation', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    getSessionByIdCommandMock.mockResolvedValue({
      id: '6a1f8f1e-0000-4000-8000-000000000004',
      title: 'Task-only session',
      ownerName: 'User',
      ownerEmail: 'user@example.com',
      ownerImageUrl: null,
      sourceSurface: 'web',
      fastConversationId: null,
      directInferenceCostMicroUsd: 0,
      inferenceCostMicroUsd: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'completed',
      tasks: [
        {
          taskId: 'task-2',
          title: 'Delegated task',
          inferenceCostMicroUsd: 0,
        },
      ],
    });

    const html = renderToStaticMarkup(
      await SessionDetailPage({
        params: Promise.resolve({
          sessionId: '6a1f8f1e-0000-4000-8000-000000000004',
        }),
      }),
    );

    expect(getFastSessionByIdMock).not.toHaveBeenCalled();
    expect(transcriptMock).not.toHaveBeenCalled();
    expect(html).toContain('Task-only session');
  });

  it('falls back to the Fast conversation lookup when no session row exists', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    getFastSessionByIdMock.mockResolvedValue({
      id: '6a1f8f1e-0000-4000-8000-000000000005',
      userId: 'user-1',
      ownerName: 'User',
      ownerEmail: 'user@example.com',
      surface: 'slack',
      model: null,
      reasoningEffort: null,
      directInferenceCostMicroUsd: 100_000,
      inferenceCostMicroUsd: 100_000,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      messages: [],
      hasOlderMessages: false,
    });
    getFastSessionTasksMock.mockResolvedValue([
      {
        taskId: 'task-1',
        title: 'Delegated task',
        inferenceCostMicroUsd: 200_000,
        artifacts: [
          {
            id: 'artifact-1',
            path: 'reports/result.md',
            version: 1,
            artifactType: 'plan',
            contentType: 'text/markdown',
            size: 200,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      },
      {
        taskId: 'task-2',
        title: 'Zero-cost task',
        inferenceCostMicroUsd: 0,
        artifacts: [],
      },
    ]);

    renderToStaticMarkup(
      await SessionDetailPage({
        params: Promise.resolve({
          sessionId: '6a1f8f1e-0000-4000-8000-000000000005',
        }),
      }),
    );

    expect(getSessionByIdCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      '6a1f8f1e-0000-4000-8000-000000000005',
    );
    expect(getFastSessionByIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      '6a1f8f1e-0000-4000-8000-000000000005',
    );
    expect(getFastSessionTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      '6a1f8f1e-0000-4000-8000-000000000005',
    );
    expect(sessionWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          id: '6a1f8f1e-0000-4000-8000-000000000005',
          taskSource: 'fast',
          taskCards: expect.arrayContaining([
            expect.objectContaining({ taskId: 'task-1' }),
            expect.objectContaining({ taskId: 'task-2' }),
          ]),
          inferenceCostMicroUsd: 300_000,
          inferenceCostBreakdown: {
            directInferenceCostMicroUsd: 100_000,
            tasks: [
              expect.objectContaining({
                taskId: 'task-1',
                inferenceCostMicroUsd: 200_000,
              }),
              expect.objectContaining({
                taskId: 'task-2',
                inferenceCostMicroUsd: 0,
              }),
            ],
          },
        }),
      }),
      undefined,
    );
  });
});
