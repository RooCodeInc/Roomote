import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const {
  authorizeMock,
  resolveEffectiveModelRuntimeEnvMock,
  getFastSessionByIdMock,
  getFastSessionTasksMock,
  getSessionByIdCommandMock,
  transcriptMock,
  sessionTaskTimelineMock,
  sessionWorkspaceMock,
  sessionReadTrackerMock,
} = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  resolveEffectiveModelRuntimeEnvMock: vi.fn(),
  getFastSessionByIdMock: vi.fn(),
  getFastSessionTasksMock: vi.fn(),
  getSessionByIdCommandMock: vi.fn(),
  transcriptMock: vi.fn(
    ({
      footer,
      headerActions,
    }: {
      messages: unknown[];
      footer?: ReactNode;
      headerExtras?: ReactNode;
      headerActions?: ReactNode;
    }) => (
      <div data-testid="transcript">
        {headerActions}
        {footer}
      </div>
    ),
  ),
  sessionTaskTimelineMock: vi.fn(() => (
    <div data-testid="session-task-timeline" />
  )),
  sessionWorkspaceMock: vi.fn(({ children }: { children: ReactNode }) => (
    <main data-testid="workspace-surface">{children}</main>
  )),
  sessionReadTrackerMock: vi.fn(() => null),
}));

vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  resolveEffectiveModelRuntimeEnv: resolveEffectiveModelRuntimeEnvMock,
}));
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
  WorkspaceHeader: ({
    children,
    contentClassName,
    actions,
  }: {
    children: ReactNode;
    contentClassName?: string;
    actions?: ReactNode;
  }) => (
    <header
      data-testid="workspace-header"
      data-content-class-name={contentClassName}
    >
      {children}
      {actions}
    </header>
  ),
  WorkspaceSurface: ({ children }: { children: ReactNode }) => (
    <main data-testid="workspace-surface">{children}</main>
  ),
}));
vi.mock('./FastSessionTranscript', () => ({
  FastSessionTranscript: transcriptMock,
}));
vi.mock('./SessionTaskTimeline', () => ({
  SessionTaskTimeline: sessionTaskTimelineMock,
}));
vi.mock('./SessionWorkspace', () => ({
  SessionWorkspace: sessionWorkspaceMock,
  SessionHeaderPullRequests: () => (
    <div data-testid="session-header-pull-requests" />
  ),
}));
vi.mock('./SessionReadTracker', () => ({
  SessionReadTracker: sessionReadTrackerMock,
}));
vi.mock('@/components/sessions/SessionViewers', () => ({
  SessionViewers: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-viewers" data-session-id={sessionId} />
  ),
}));

import SessionDetailPage, { generateMetadata } from './page';

describe('Session detail page', () => {
  it.each(['user-1', 'other-user'])(
    'exposes secret management only to the owner with canonical identity (%s)',
    async (userId) => {
      authorizeMock.mockResolvedValue({
        success: true,
        userId,
        isAdmin: false,
      });
      getSessionByIdCommandMock.mockResolvedValue({
        id: '6a1f8f1e-0000-4000-8000-000000000006',
        ownerUserId: 'user-1',
        title: 'Session',
        ownerName: 'Owner',
        sourceSurface: 'web',
        fastConversationId: '6a1f8f1e-0000-4000-8000-000000000005',
        tasks: [],
        artifacts: [],
        inferenceCostMicroUsd: 0,
        directInferenceCostMicroUsd: 0,
        createdAt: new Date(),
        status: 'active',
      });
      getFastSessionByIdMock.mockResolvedValue({
        id: '6a1f8f1e-0000-4000-8000-000000000005',
        messages: [],
        model: null,
        reasoningEffort: null,
      });
      renderToStaticMarkup(
        await SessionDetailPage({
          params: Promise.resolve({
            sessionId: '6a1f8f1e-0000-4000-8000-000000000006',
          }),
        }),
      );
      expect(transcriptMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: '6a1f8f1e-0000-4000-8000-000000000005',
          secretSessionId:
            userId === 'user-1'
              ? '6a1f8f1e-0000-4000-8000-000000000006'
              : undefined,
        }),
        undefined,
      );
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    resolveEffectiveModelRuntimeEnvMock.mockResolvedValue({});
    getSessionByIdCommandMock.mockResolvedValue(null);
    getFastSessionTasksMock.mockResolvedValue([]);
  });

  it('loads session data and model configuration in parallel', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    const sessionLookup = Promise.withResolvers<{
      id: string;
      title: string;
      ownerName: string;
      ownerEmail: string;
      ownerImageUrl: null;
      sourceSurface: string;
      fastConversationId: null;
      directInferenceCostMicroUsd: number;
      inferenceCostMicroUsd: number;
      createdAt: Date;
      status: string;
      tasks: [];
    }>();
    const modelLookup = Promise.withResolvers<Record<string, string>>();
    getSessionByIdCommandMock.mockReturnValue(sessionLookup.promise);
    resolveEffectiveModelRuntimeEnvMock.mockReturnValue(modelLookup.promise);

    const renderPromise = SessionDetailPage({
      params: Promise.resolve({
        sessionId: '6a1f8f1e-0000-4000-8000-000000000007',
      }),
    });

    await vi.waitFor(() => {
      expect(getSessionByIdCommandMock).toHaveBeenCalledOnce();
      expect(resolveEffectiveModelRuntimeEnvMock).toHaveBeenCalledOnce();
    });

    sessionLookup.resolve({
      id: '6a1f8f1e-0000-4000-8000-000000000007',
      title: 'Parallel session lookup',
      ownerName: 'User',
      ownerEmail: 'user@example.com',
      ownerImageUrl: null,
      sourceSurface: 'web',
      fastConversationId: null,
      directInferenceCostMicroUsd: 0,
      inferenceCostMicroUsd: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'completed',
      tasks: [],
    });
    modelLookup.resolve({});

    await expect(renderPromise).resolves.toBeDefined();
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

    const html = renderToStaticMarkup(
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
    expect(html).toContain('data-testid="session-viewers"');
    expect(html).toContain(
      'data-session-id="6a1f8f1e-0000-4000-8000-000000000002"',
    );
    expect(html).not.toContain(
      'data-session-id="6a1f8f1e-0000-4000-8000-000000000005"',
    );
    expect(sessionReadTrackerMock).toHaveBeenCalledWith(
      { sessionId: '6a1f8f1e-0000-4000-8000-000000000002' },
      undefined,
    );
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
    expect(transcriptMock.mock.calls[0]?.[0]).toHaveProperty('headerExtras');
    const headerExtras = transcriptMock.mock.calls[0]?.[0].headerExtras;
    expect(isValidElement(headerExtras)).toBe(true);
    expect(isValidElement(headerExtras) ? headerExtras.key : null).toBe(
      'session-pull-requests',
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
      title: 'Task-only session with a title that wraps on narrow screens',
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
    expect(html).toContain(
      'Task-only session with a title that wraps on narrow screens',
    );
    expect(html).toContain('data-testid="session-viewers"');
    expect(html).toContain(
      'data-session-id="6a1f8f1e-0000-4000-8000-000000000004"',
    );
    expect(html).toContain(
      'class="min-w-0 max-w-full flex-[0_1_auto] cursor-default break-words text-sm font-medium @[600px]:truncate"',
    );
    expect(html).toContain('session-header-pull-requests');
    expect(html).toContain('session-task-timeline');
    expect(html).not.toContain('completed');
    expect(sessionTaskTimelineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '6a1f8f1e-0000-4000-8000-000000000004',
        initialTasks: [
          expect.objectContaining({
            taskId: 'task-2',
            title: 'Delegated task',
          }),
        ],
      }),
      undefined,
    );
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

    const html = renderToStaticMarkup(
      await SessionDetailPage({
        params: Promise.resolve({
          sessionId: '6a1f8f1e-0000-4000-8000-000000000005',
        }),
      }),
    );

    expect(transcriptMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'headerActions',
    );
    expect(html).not.toContain('data-testid="session-viewers"');
    expect(sessionReadTrackerMock).not.toHaveBeenCalled();
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
