import { act, render, screen } from '@testing-library/react';

import { LazyMessage } from './LazyMessage';

interface MockIntersectionObserverRecord {
  callback: IntersectionObserverCallback;
  disconnect: ReturnType<typeof vi.fn>;
  instance: IntersectionObserver;
  observe: ReturnType<typeof vi.fn>;
  options?: IntersectionObserverInit;
  unobserve: ReturnType<typeof vi.fn>;
}

let observerRecords: MockIntersectionObserverRecord[] = [];

function getWrapper(container: HTMLElement) {
  const wrapper = container.querySelector('#message-anchor');

  if (!(wrapper instanceof HTMLDivElement)) {
    throw new Error('Expected LazyMessage wrapper to be rendered');
  }

  return wrapper;
}

async function flushObserverSetup() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
  });
}

function emitIntersection(
  record: MockIntersectionObserverRecord,
  target: Element,
  isIntersecting: boolean,
) {
  act(() => {
    record.callback(
      [
        {
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRatio: isIntersecting ? 1 : 0,
          intersectionRect: isIntersecting
            ? target.getBoundingClientRect()
            : new DOMRectReadOnly(),
          isIntersecting,
          rootBounds: null,
          target,
          time: 0,
        } satisfies IntersectionObserverEntry,
      ],
      record.instance,
    );
  });
}

describe('LazyMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    observerRecords = [];

    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      clearTimeout(handle);
    });

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly scrollMargin = '';
      readonly thresholds = [];
      readonly disconnect = vi.fn();
      readonly observe = vi.fn();
      readonly takeRecords = vi.fn(() => []);
      readonly unobserve = vi.fn();

      constructor(
        public readonly callback: IntersectionObserverCallback,
        public readonly options?: IntersectionObserverInit,
      ) {
        observerRecords.push({
          callback,
          disconnect: this.disconnect,
          instance: this,
          observe: this.observe,
          options,
          unobserve: this.unobserve,
        });
      }
    }

    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as typeof IntersectionObserver,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('debounces collapse and preserves exact placeholder height after unmounting', async () => {
    const { container } = render(
      <LazyMessage anchorId="message-anchor">
        <div>Message body</div>
      </LazyMessage>,
    );

    await flushObserverSetup();

    expect(observerRecords).toHaveLength(1);
    expect(observerRecords[0]?.options?.rootMargin).toBe('4000px 0px');

    const wrapper = getWrapper(container);
    Object.defineProperty(wrapper, 'offsetHeight', {
      configurable: true,
      value: 120,
    });

    emitIntersection(observerRecords[0]!, wrapper, false);

    expect(screen.getByText('Message body')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });

    expect(screen.getByText('Message body')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.queryByText('Message body')).not.toBeInTheDocument();
    expect(wrapper.style.height).toBe('120px');
    expect(wrapper.style.minHeight).toBe('');
    expect(wrapper.style.overflow).toBe('hidden');
  });

  it('cancels a pending collapse when the message re-enters the viewport', async () => {
    const { container } = render(
      <LazyMessage anchorId="message-anchor">
        <div>Message body</div>
      </LazyMessage>,
    );

    await flushObserverSetup();

    const wrapper = getWrapper(container);
    Object.defineProperty(wrapper, 'offsetHeight', {
      configurable: true,
      value: 120,
    });

    emitIntersection(observerRecords[0]!, wrapper, false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    emitIntersection(observerRecords[0]!, wrapper, true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByText('Message body')).toBeInTheDocument();
  });

  it('re-renders immediately when the message enters the viewport again', async () => {
    const { container } = render(
      <LazyMessage anchorId="message-anchor">
        <div>Message body</div>
      </LazyMessage>,
    );

    await flushObserverSetup();

    const wrapper = getWrapper(container);
    Object.defineProperty(wrapper, 'offsetHeight', {
      configurable: true,
      value: 120,
    });

    emitIntersection(observerRecords[0]!, wrapper, false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.queryByText('Message body')).not.toBeInTheDocument();

    emitIntersection(observerRecords[0]!, wrapper, true);

    expect(screen.getByText('Message body')).toBeInTheDocument();
  });
});
