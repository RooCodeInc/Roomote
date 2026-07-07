import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { AcpUiMessage } from '../types';

vi.mock('@/components/ai-elements', () => ({
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Reasoning: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ReasoningTrigger: () => <div data-testid="reasoning-trigger">Thought</div>,
  ReasoningContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

const { messageUiOptionsState } = vi.hoisted(() => ({
  messageUiOptionsState: {
    displayMode: 'default' as 'default' | 'narration',
  },
}));

vi.mock('../../../hooks/SandboxProvider', () => ({
  useInitialSandboxReasoningExpanded: vi.fn().mockReturnValue(false),
  useSandboxSetReasoningExpanded: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('@/components/ai-elements/message-ui-options', () => ({
  useMessageUiOptions: () => messageUiOptionsState,
}));

vi.mock('@/components/system', () => ({
  Lightbulb: () => <svg aria-hidden="true" />,
}));

import { AcpReasoningMessage } from '../AcpReasoningMessage';

function reasoningMessage(text: string, partial: boolean): AcpUiMessage {
  return {
    id: 'reasoning-1',
    ts: 1,
    role: 'assistant',
    kind: 'reasoning',
    partial,
    sessionId: 'session-1',
    updateType: partial
      ? 'roomote_runtime.assistant_thought_chunk'
      : 'roomote_runtime.assistant_thought',
    text,
    data: {},
  };
}

describe('AcpReasoningMessage', () => {
  beforeEach(() => {
    messageUiOptionsState.displayMode = 'default';
  });

  it('renders streaming reasoning immediately in default mode', () => {
    const { queryByText, queryByTestId } = render(
      <AcpReasoningMessage msg={reasoningMessage('Streaming thought', true)} />,
    );

    expect(queryByText('Streaming thought')).toBeInTheDocument();
    expect(queryByTestId('reasoning-trigger')).toBeInTheDocument();
  });

  it('keeps short-lived reasoning visible when streaming ends in default mode', () => {
    const onSuppress = vi.fn();
    const { queryByText, rerender } = render(
      <AcpReasoningMessage
        msg={reasoningMessage('Short thought', true)}
        onSuppress={onSuppress}
      />,
    );

    expect(queryByText('Short thought')).toBeInTheDocument();

    rerender(
      <AcpReasoningMessage
        msg={reasoningMessage('Short thought', false)}
        onSuppress={onSuppress}
      />,
    );

    expect(queryByText('Short thought')).toBeInTheDocument();
    expect(onSuppress).not.toHaveBeenCalled();
  });

  it('renders persisted completed reasoning immediately', () => {
    const { queryByText } = render(
      <AcpReasoningMessage
        msg={reasoningMessage('Persisted thought', false)}
      />,
    );

    expect(queryByText('Persisted thought')).toBeInTheDocument();
  });

  it('renders narration-mode reasoning inline with a static label', () => {
    messageUiOptionsState.displayMode = 'narration';

    const { queryByText, queryByTestId } = render(
      <AcpReasoningMessage msg={reasoningMessage('Narrated thought', false)} />,
    );

    expect(queryByText('Thought')).toBeInTheDocument();
    expect(queryByText('Narrated thought')).toBeInTheDocument();
    expect(queryByTestId('reasoning-trigger')).not.toBeInTheDocument();
  });

  it('renders short-lived streaming reasoning in narration mode without suppressing it', () => {
    messageUiOptionsState.displayMode = 'narration';
    const onSuppress = vi.fn();
    const { queryByText, rerender } = render(
      <AcpReasoningMessage
        msg={reasoningMessage('Narrated stream', true)}
        onSuppress={onSuppress}
      />,
    );

    expect(queryByText('Narrated stream')).toBeInTheDocument();

    rerender(
      <AcpReasoningMessage
        msg={reasoningMessage('Narrated stream', false)}
        onSuppress={onSuppress}
      />,
    );

    expect(queryByText('Narrated stream')).toBeInTheDocument();
    expect(onSuppress).not.toHaveBeenCalled();
  });
});
