import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';

import { LazyViewportItem } from './LazyViewportItem';

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
  const wrapper = container.querySelector('#lazy-anchor');

  if (!(wrapper instanceof HTMLDivElement)) {
    throw new Error('Expected LazyViewportItem wrapper to be rendered');
  }

  return wrapper;
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

function TestHarness({ estimatedHeight = 240 }: { estimatedHeight?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div ref={rootRef} data-testid="scroll-root" />
      <LazyViewportItem
        anchorId="lazy-anchor"
        rootRef={rootRef}
        estimatedHeight={estimatedHeight}
      >
        <div>Deferred diff body</div>
      </LazyViewportItem>
    </>
  );
}

function VisibleTestHarness() {
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div ref={rootRef} data-testid="scroll-root" />
      <LazyViewportItem
        anchorId="lazy-anchor"
        rootRef={rootRef}
        defaultVisible={true}
      >
        <div>Visible message body</div>
      </LazyViewportItem>
    </>
  );
}

describe('LazyViewportItem', () => {
  beforeEach(() => {
    observerRecords = [];

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
  });

  it('uses the provided observer root and preserves the estimated placeholder height before mounting', () => {
    const { container } = render(<TestHarness />);

    expect(observerRecords).toHaveLength(1);
    expect(observerRecords[0]?.options?.root).toBe(
      screen.getByTestId('scroll-root'),
    );
    expect(screen.queryByText('Deferred diff body')).not.toBeInTheDocument();

    const wrapper = getWrapper(container);
    expect(wrapper.style.height).toBe('240px');
    expect(wrapper.style.overflow).toBe('hidden');
  });

  it('mounts the content when the wrapper enters the observed viewport', () => {
    const { container } = render(<TestHarness />);

    const wrapper = getWrapper(container);
    emitIntersection(observerRecords[0]!, wrapper, true);

    expect(screen.getByText('Deferred diff body')).toBeInTheDocument();
  });

  it('refreshes the placeholder height when a hidden item receives a new estimate', () => {
    const { container, rerender } = render(
      <TestHarness estimatedHeight={240} />,
    );

    const wrapper = getWrapper(container);
    expect(wrapper.style.height).toBe('240px');

    rerender(<TestHarness estimatedHeight={360} />);

    expect(wrapper.style.height).toBe('360px');
  });

  it('does not collapse a visible item when no placeholder height is available yet', () => {
    const { container } = render(<VisibleTestHarness />);

    const wrapper = getWrapper(container);
    expect(screen.getByText('Visible message body')).toBeInTheDocument();

    emitIntersection(observerRecords[0]!, wrapper, false);

    expect(screen.getByText('Visible message body')).toBeInTheDocument();
  });
});
