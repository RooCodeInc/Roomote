import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/ai-elements', () => ({
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/system', () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Lightbulb: () => null,
  X: () => null,
}));

import {
  getTipDisplayDurationMs,
  PRODUCT_TIPS,
  ProductTips,
} from './ProductTips';

describe('ProductTips', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('cycles through the shuffled tips using reading-time durations', () => {
    render(<ProductTips />);

    act(() => {});
    expect(screen.getByText(PRODUCT_TIPS[0].title)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(getTipDisplayDurationMs(PRODUCT_TIPS[0]));
    });

    expect(screen.getByText(PRODUCT_TIPS[1].title)).toBeInTheDocument();
  });

  it('persists dismissal and stays hidden on later mounts', () => {
    const { unmount } = render(<ProductTips />);

    act(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Hide product tips' }));

    expect(screen.queryByText(PRODUCT_TIPS[0].title)).not.toBeInTheDocument();

    unmount();
    render(<ProductTips />);
    act(() => {});

    expect(
      screen.queryByRole('button', { name: 'Hide product tips' }),
    ).toBeNull();
  });
});
