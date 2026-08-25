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
vi.mock('@/lib/server/fast-sessions', () => ({
  getFastSessionById: getFastSessionByIdMock,
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
      conversationId: 'conversation-1',
      currentReplyChannelId: 'channel-1',
      currentReplyThreadId: 'thread-1',
      replyTargetVerified: true,
      openCodeSessionId: 'opencode-1',
      messageCount: 2,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      transcript: [
        { id: 'message-1', role: 'user', text: 'Question' },
        { id: 'message-2', role: 'assistant', text: 'Answer' },
      ],
      linkedTasks: [
        {
          taskId: 'task-1',
          title: 'Delegated task',
          status: 'completed',
          taskPhase: null,
          createdAt: new Date('2026-01-01T01:00:00.000Z'),
        },
      ],
    });

    const html = renderToStaticMarkup(
      await SessionDetailPage({
        params: Promise.resolve({ sessionId: 'session-1' }),
      }),
    );

    expect(html).toContain('data-testid="workspace-surface"');
    expect(html).toContain('data-testid="workspace-header"');
    expect(html).toContain('Fast OpenCode session');
    expect(html).toContain('Delegated task');
    expect(html).toContain('OpenCode workspace details unavailable');
    expect(transcriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ text: 'Question' }),
        ]),
      }),
      undefined,
    );
  });
});
