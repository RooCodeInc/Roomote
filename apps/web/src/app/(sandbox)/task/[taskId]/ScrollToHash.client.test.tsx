import { act, render, screen } from '@testing-library/react';

const { stopScroll } = vi.hoisted(() => ({
  stopScroll: vi.fn(),
}));

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottomContext: () => ({ stopScroll }),
}));

import { ScrollToHash } from './ScrollToHash';

describe('ScrollToHash', () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    stopScroll.mockReset();
    document.body.innerHTML = '';
    window.location.hash = '';
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  function renderDuplicateAnchorMessage(id: string, text: string) {
    return (
      <div id={id} data-testid={`anchor-${id}`}>
        <div className="chat-message" data-testid={`message-${id}`}>
          <div id={id} data-testid={`content-${id}`}>
            {text}
          </div>
        </div>
      </div>
    );
  }

  async function flushHighlightDelay() {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }

  it('scrolls to the hash target and highlights the chat message instead of the anchor wrapper', async () => {
    window.location.hash = '#msg-123';

    render(
      <>
        {renderDuplicateAnchorMessage('msg-123', 'Target message')}
        <ScrollToHash messages={[{ ts: 123 }]} />
      </>,
    );

    await flushHighlightDelay();

    expect(stopScroll).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
    expect(screen.getByTestId('message-msg-123')).toHaveClass(
      'permalink-highlight',
    );
    expect(screen.getByTestId('anchor-msg-123')).not.toHaveClass(
      'permalink-highlight',
    );
    expect(screen.getByTestId('content-msg-123')).not.toHaveClass(
      'permalink-highlight',
    );
  });

  it('moves the highlight to the latest hash target when the hash changes', async () => {
    window.location.hash = '#msg-123';

    render(
      <>
        {renderDuplicateAnchorMessage('msg-123', 'First message')}
        {renderDuplicateAnchorMessage('msg-456', 'Second message')}
        <ScrollToHash messages={[{ ts: 123 }, { ts: 456 }]} />
      </>,
    );

    await flushHighlightDelay();

    expect(screen.getByTestId('message-msg-123')).toHaveClass(
      'permalink-highlight',
    );

    await act(async () => {
      window.location.hash = '#msg-456';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      vi.advanceTimersByTime(1000);
    });

    expect(stopScroll).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('message-msg-123')).not.toHaveClass(
      'permalink-highlight',
    );
    expect(screen.getByTestId('message-msg-456')).toHaveClass(
      'permalink-highlight',
    );
  });

  it('reschedules the pending highlight when messages rerender for the same hash', async () => {
    window.location.hash = '#msg-123';

    const { rerender } = render(
      <>
        {renderDuplicateAnchorMessage('msg-123', 'Target message')}
        <ScrollToHash messages={[{ ts: 123 }]} />
      </>,
    );

    rerender(
      <>
        {renderDuplicateAnchorMessage('msg-123', 'Target message')}
        <ScrollToHash messages={[{ ts: 123 }, { ts: 456 }]} />
      </>,
    );

    await flushHighlightDelay();

    expect(stopScroll).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('message-msg-123')).toHaveClass(
      'permalink-highlight',
    );
  });
});
