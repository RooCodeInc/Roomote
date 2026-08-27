import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { authorizeMock, getFastSessionByIdMock, transcriptMock } = vi.hoisted(
  () => ({
    authorizeMock: vi.fn(),
    getFastSessionByIdMock: vi.fn(),
    transcriptMock: vi.fn(
      ({ footer }: { messages: unknown[]; footer?: ReactNode }) => (
        <div data-testid="transcript">{footer}</div>
      ),
    ),
  }),
);

vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/server/fast-sessions', () => ({
  getFastSessionById: getFastSessionByIdMock,
}));
vi.mock('../../use-sandbox-layout', () => ({
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

import SessionDetailPage from './page';

describe('Fast session detail page', () => {
  it('uses the shared task workspace and renders supported session data', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      userId: 'user-1',
      isAdmin: false,
    });
    getFastSessionByIdMock.mockResolvedValue({
      id: 'session-1',
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
        params: Promise.resolve({ sessionId: 'session-1' }),
      }),
    );

    expect(html).toContain('data-testid="workspace-surface"');
    expect(html).not.toContain('Delegated tasks');
    expect(html).not.toContain('Session context');
    expect(html).not.toContain('OpenCode workspace details unavailable');
    expect(transcriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
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
      id: 'session-2',
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
        params: Promise.resolve({ sessionId: 'session-2' }),
      }),
    );

    expect(html).not.toContain('b3b0a53e-6dab-4bb8-b3a5-111111111111');
    expect(transcriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-2',
        canReply: true,
        initialTitle: 'Rotate the API keys',
        fallbackTitle: 'Session',
      }),
      undefined,
    );
  });
});
