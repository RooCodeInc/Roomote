import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { AcpUiMessage } from '../types';

vi.mock('@/components/ai-elements', () => ({
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Reasoning: ({ children, open }: { children: ReactNode; open?: boolean }) => (
    <div data-reasoning-open={String(open)}>{children}</div>
  ),
  ReasoningTrigger: () => <div data-testid="reasoning-trigger">Thought</div>,
  ReasoningContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

const { initialExpandedState, messageUiOptionsState } = vi.hoisted(() => ({
  initialExpandedState: { value: null as boolean | null },
  messageUiOptionsState: {
    displayMode: 'default' as 'default' | 'narration',
    expandReasoningByDefault: false,
  },
}));

vi.mock('../../../hooks/SandboxProvider', () => ({
  useInitialSandboxReasoningExpanded: () => initialExpandedState.value,
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
    initialExpandedState.value = null;
    messageUiOptionsState.displayMode = 'default';
    messageUiOptionsState.expandReasoningByDefault = false;
  });

  it('opens reasoning when mind reader mode supplies the default', () => {
    messageUiOptionsState.expandReasoningByDefault = true;

    const { container } = render(
      <AcpReasoningMessage msg={reasoningMessage('Expanded thought', false)} />,
    );

    expect(
      container.querySelector('[data-reasoning-open="true"]'),
    ).not.toBeNull();
  });

  it('prefers the conversation expansion state after a manual choice', () => {
    initialExpandedState.value = false;
    messageUiOptionsState.expandReasoningByDefault = true;

    const { container } = render(
      <AcpReasoningMessage
        msg={reasoningMessage('Collapsed thought', false)}
      />,
    );

    expect(
      container.querySelector('[data-reasoning-open="false"]'),
    ).not.toBeNull();
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
