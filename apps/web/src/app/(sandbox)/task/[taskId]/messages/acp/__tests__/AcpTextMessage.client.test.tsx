import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

const transcriptVisibilityState = vi.hoisted(() => ({
  enabled: false,
}));

vi.mock('@/components/ai-elements', () => ({
  Attachment: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  AttachmentPreview: () => <div data-testid="attachment-preview" />,
  Attachments: ({ children }: { children: ReactNode }) => (
    <div data-testid="attachments">{children}</div>
  ),
  CollapsibleContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageActions: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageContent: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => (
    <div data-testid="message-content" className={className}>
      {children}
    </div>
  ),
  MessageCopyButton: ({ content }: { content: string }) => (
    <button type="button">copy:{content}</button>
  ),
  MessageNewTaskButton: ({ content }: { content: string }) => (
    <button type="button">new-task:{content}</button>
  ),
  MessagePlainText: ({ children }: { children: ReactNode }) => (
    <div data-testid="message-plain-text">{children}</div>
  ),
  MessageResponse: ({ children }: { children: ReactNode }) => (
    <div data-testid="message-response">{children}</div>
  ),
  MessageTimestamp: ({ ts, anchorId }: { ts: number; anchorId?: string }) => (
    <time data-anchor-id={anchorId}>{String(ts)}</time>
  ),
}));
vi.mock('@/components/system', () => ({
  BasicTooltip: ({
    children,
    content,
  }: {
    children: ReactNode;
    content: ReactNode;
  }) => (
    <div data-testid="basic-tooltip" data-content={String(content)}>
      {children}
    </div>
  ),
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  ChevronDownIcon: () => <svg aria-label="ChevronDownIcon" />,
  GitCommitVertical: () => <svg aria-label="GitCommitVertical" />,
  GitPullRequestCreateArrow: () => (
    <svg aria-label="GitPullRequestCreateArrow" />
  ),
  GitPullRequestDraft: () => <svg aria-label="GitPullRequestDraft" />,
  Image: () => <svg aria-label="Image" />,
  ListChecks: () => <svg aria-label="ListChecks" />,
  MediaViewerDialog: ({
    children,
    open,
    title,
  }: {
    children: ReactNode;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <div data-testid="media-viewer" aria-label={title}>
        {children}
      </div>
    ) : null,
  MediaViewerImage: ({ alt }: { alt: string }) => (
    <div role="img" aria-label={alt} />
  ),
  ScanFace: () => <svg aria-label="ScanFace" />,
  ScanSearch: () => <svg aria-label="ScanSearch" />,
  Sparkles: () => <svg aria-label="Sparkles" />,
}));

vi.mock('../../../useInternalTranscriptRowsVisible', () => ({
  useInternalTranscriptRowsVisible: () => transcriptVisibilityState.enabled,
}));

import { AcpTextMessage } from '../AcpTextMessage';

describe('AcpTextMessage', () => {
  beforeEach(() => {
    transcriptVisibilityState.enabled = false;
  });

  it('shows copy and new task actions for assistant completion text', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          isTurnCompletion: true,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: 'Done!',
          data: {},
        }}
      />,
    );

    expect(screen.getByRole('button', { name: 'copy:Done!' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'new-task:Done!' }),
    ).toBeVisible();
  });

  it('passes a permalink anchor id to the timestamp', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          isTurnCompletion: true,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: 'Done!',
          data: {},
        }}
      />,
    );

    expect(screen.getByText('123')).toHaveAttribute(
      'data-anchor-id',
      'msg-123',
    );
  });

  it('keeps the timestamp persistently visible in debug mode while preserving content actions', () => {
    transcriptVisibilityState.enabled = true;

    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          isTurnCompletion: true,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: 'Done!',
          data: {},
        }}
      />,
    );

    expect(screen.getAllByText('123', { selector: 'time' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'copy:Done!' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'new-task:Done!' }),
    ).toBeVisible();
  });

  it('uses compact vertical padding for assistant text messages', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          isTurnCompletion: true,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: 'Done!',
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('message-content')).toHaveClass('py-0');
  });

  it('keeps the larger top padding for user text messages', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: 'Continue',
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('message-content')).toHaveClass('pt-8');
  });

  it('renders optimistic user text messages without extra pending chrome', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          optimistic: true,
          clientMessageId: 'client-1',
          sessionId: null,
          updateType: 'roomote_runtime.user_prompt',
          text: 'Continue',
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('message-content')).not.toHaveClass(
      'group-[.is-user]:opacity-95',
      'transition-opacity',
    );
    expect(screen.queryByText('Sending')).not.toBeInTheDocument();
  });

  it('hides assistant content actions for non-completion text', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: 'Intermediate note',
          data: {},
        }}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'copy:Intermediate note' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'new-task:Intermediate note' }),
    ).not.toBeInTheDocument();
  });

  it('does not show copy and new task actions while assistant text is streaming', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: true,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: 'Still working...',
          data: {},
        }}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'copy:Still working...' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'new-task:Still working...' }),
    ).not.toBeInTheDocument();
  });

  it('shows copy and new task actions for user text', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: 'Continue',
          data: {},
        }}
      />,
    );

    expect(screen.getByRole('button', { name: 'copy:Continue' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'new-task:Continue' }),
    ).toBeVisible();
  });

  it('renders user text as plain text instead of markdown', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: '**bold**\n- list item\n[example](https://example.com)',
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('message-plain-text')).toHaveTextContent(
      '**bold**',
    );
    expect(screen.queryByTestId('message-response')).not.toBeInTheDocument();
  });

  it('continues rendering assistant text through the markdown renderer', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          isTurnCompletion: true,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: '**Done!**',
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('message-response')).toHaveTextContent(
      '**Done!**',
    );
    expect(screen.queryByTestId('message-plain-text')).not.toBeInTheDocument();
  });

  it('strips citation artifacts from assistant text before rendering and actions', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: 'Answer \uE200cite\uE202turn1search0\uE201',
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('message-response')).toHaveTextContent('Answer');
    expect(screen.queryByText('turn1search0')).not.toBeInTheDocument();
  });

  it('renders slash commands as chips and hides content actions', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: '/capture-visual-proof',
          data: {},
        }}
      />,
    );

    expect(screen.getByText('Capture visual proof')).toBeVisible();
    expect(
      screen.queryByRole('button', {
        name: 'copy:/capture-visual-proof',
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'new-task:/capture-visual-proof',
      }),
    ).not.toBeInTheDocument();
  });

  it('renders the address PR feedback packaged invocation as a chip', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: '$address-pr-feedback',
          data: {},
        }}
      />,
    );

    expect(screen.getByText('Address PR feedback')).toBeVisible();
    expect(
      screen.queryByRole('button', {
        name: 'copy:$address-pr-feedback',
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'new-task:$address-pr-feedback',
      }),
    ).not.toBeInTheDocument();
  });

  it('renders linked review handoffs as structured status cards', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-review-1',
          ts: 456,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: [
            '<review_result>',
            '<review_kind>sync</review_kind>',
            '<outcome>findings_remain</outcome>',
            '<finding_count>2</finding_count>',
            '<summary>2 actionable findings still remain after the latest push.</summary>',
            '</review_result>',
          ].join('\n'),
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('linked-review-result')).toBeVisible();
    expect(screen.getByTestId('linked-review-result-title')).toHaveTextContent(
      'Re-review finished: 2 actionable findings remain',
    );
    expect(
      screen.getByTestId('linked-review-result-summary'),
    ).toHaveTextContent(
      '2 actionable findings still remain after the latest push.',
    );
    expect(
      screen.queryByRole('button', {
        name: /copy:/,
      }),
    ).not.toBeInTheDocument();
  });

  it('keeps the debug timestamp visible for task-tool prompts', () => {
    transcriptVisibilityState.enabled = true;

    render(
      <AcpTextMessage
        msg={{
          id: 'message-task-tool-1',
          ts: 124,
          previousTs: 120,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: '$address-pr-feedback',
          data: {},
        }}
      />,
    );

    expect(screen.getByText('Address PR feedback')).toBeVisible();
    expect(screen.getAllByText('124', { selector: 'time' })).toHaveLength(1);
  });

  it('keeps the debug timestamp visible for linked review-result prompts', () => {
    transcriptVisibilityState.enabled = true;

    render(
      <AcpTextMessage
        msg={{
          id: 'message-review-debug-1',
          ts: 458,
          previousTs: 456,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: [
            '<review_result>',
            '<review_kind>sync</review_kind>',
            '<outcome>findings_remain</outcome>',
            '<finding_count>2</finding_count>',
            '<summary>2 actionable findings still remain after the latest push.</summary>',
            '</review_result>',
          ].join('\n'),
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('linked-review-result')).toBeVisible();
    expect(screen.getAllByText('458', { selector: 'time' })).toHaveLength(1);
  });

  it('renders legacy code-review-results handoffs as structured status cards', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-review-legacy-1',
          ts: 457,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: [
            '<code-review-results>',
            '<review_kind>sync</review_kind>',
            '<outcome>clean</outcome>',
            '<summary>No review findings remain.</summary>',
            '</code-review-results>',
          ].join('\n'),
          data: {},
        }}
      />,
    );

    expect(screen.getByTestId('linked-review-result')).toBeVisible();
    expect(screen.getByTestId('linked-review-result-title')).toHaveTextContent(
      'Re-review finished: no actionable issues remain',
    );
    expect(
      screen.getByTestId('linked-review-result-summary'),
    ).toHaveTextContent('No review findings remain.');
    expect(
      screen.queryByRole('button', {
        name: /copy:/,
      }),
    ).not.toBeInTheDocument();
  });

  it('renders request_user_input responses as normal chat messages with context', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-rui-1',
          ts: 789,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
          text: 'Gamma',
          data: {
            resolution: 'submitted',
            request: {
              requestId: 'rui:1',
              questions: [
                {
                  id: 'choice',
                  header: 'Choice',
                  question: 'Pick one option for the third test.',
                  isOther: true,
                  isSecret: false,
                  options: [
                    {
                      label: 'Red',
                      description: 'Recommended option.',
                    },
                  ],
                },
              ],
            },
          },
        }}
      />,
    );

    const plainText = screen.getByTestId('message-plain-text');

    expect(plainText).toHaveTextContent('Pick one option for the third test.');
    expect(plainText).toHaveTextContent('Gamma');
    expect(plainText).not.toHaveTextContent('Responded to requested input');
    expect(plainText.querySelectorAll('p')).toHaveLength(1);
    expect(plainText.querySelector('p')).toHaveClass(
      'mt-1',
      'border-l-2',
      'pl-2',
      'text-muted-foreground',
    );
    expect(
      screen.getByRole('button', {
        name: /copy:/,
      }),
    ).toBeInTheDocument();
  });

  it('renders every question for multi-question request_user_input responses', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-rui-multi',
          ts: 790,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
          text: 'Color: Blue\nShape: Circle',
          data: {
            resolution: 'submitted',
            request: {
              requestId: 'rui:multi',
              questions: [
                {
                  id: 'color',
                  header: 'Color',
                  question: 'What color do you prefer?',
                  isOther: false,
                  isSecret: false,
                },
                {
                  id: 'shape',
                  header: 'Shape',
                  question: 'Which shape suits the layout best?',
                  isOther: false,
                  isSecret: false,
                },
              ],
            },
          },
        }}
      />,
    );

    expect(screen.getByTestId('message-plain-text')).toHaveTextContent(
      'What color do you prefer?',
    );
    expect(screen.getByTestId('message-plain-text')).toHaveTextContent(
      'Which shape suits the layout best?',
    );
    expect(screen.getByTestId('message-plain-text')).toHaveTextContent(
      'Color: Blue',
    );
    expect(screen.getByTestId('message-plain-text')).toHaveTextContent(
      'Shape: Circle',
    );
    expect(screen.getByTestId('message-plain-text')).not.toHaveTextContent(
      'Responded to requested input',
    );
  });

  it('shows user avatar when message has userImageUrl', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message',
          text: 'Hello',
          data: {},
          userName: 'Test User',
          userImageUrl: 'https://example.com/avatar.png',
        }}
      />,
    );

    const avatar = screen.getByRole('img', { name: 'Test User' });
    expect(avatar).toBeVisible();
    expect(screen.getByTestId('basic-tooltip')).toHaveAttribute(
      'data-content',
      'Test User',
    );
  });

  it('uses name and email in the avatar tooltip when email is available', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message',
          text: 'Hello',
          data: {},
          userName: 'Test User',
          userEmail: 'test@example.com',
          userImageUrl: 'https://example.com/avatar.png',
        }}
      />,
    );

    expect(screen.getByTestId('basic-tooltip')).toHaveAttribute(
      'data-content',
      'Test User (test@example.com)',
    );
  });

  it('does not show avatar for assistant messages', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message',
          text: 'Done!',
          data: {},
          userName: 'Test User',
          userImageUrl: 'https://example.com/avatar.png',
        }}
      />,
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('does not show avatar when userImageUrl is missing', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message',
          text: 'Hello',
          data: {},
        }}
      />,
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows copy and new task actions for optimistic user text', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'optimistic-user-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          optimistic: true,
          clientMessageId: 'client-1',
          sessionId: null,
          updateType: 'roomote_runtime.user_prompt',
          text: 'Continue',
          data: {},
        }}
      />,
    );

    expect(screen.getByRole('button', { name: 'copy:Continue' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'new-task:Continue' }),
    ).toBeVisible();
  });

  it('opens a fullscreen media viewer when an image attachment is clicked', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'user',
          kind: 'text',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.user_prompt',
          text: 'Describe this image',
          images: ['data:image/png;base64,aGVsbG8='],
          data: {},
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open conversation image attachment 1',
      }),
    );

    expect(screen.getByTestId('media-viewer')).toBeVisible();
    expect(
      screen.getByRole('img', {
        name: 'Conversation image attachment 1',
      }),
    ).toBeVisible();
  });

  it('preserves leading and trailing whitespace in assistant action content', () => {
    render(
      <AcpTextMessage
        msg={{
          id: 'message-1',
          ts: 123,
          role: 'assistant',
          kind: 'text',
          partial: false,
          isTurnCompletion: true,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_message_chunk',
          text: '  Done!  ',
          data: {},
        }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'copy: Done!' }).textContent,
    ).toBe('copy:  Done!  ');
    expect(
      screen.getByRole('button', { name: 'new-task: Done!' }).textContent,
    ).toBe('new-task:  Done!  ');
  });
});
