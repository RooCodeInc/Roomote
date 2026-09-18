import { useRef } from 'react';
import { act, render } from '@testing-library/react';

import { useAutoFocusOnce } from './useAutoFocusOnce';

function AutoFocusFixture({ enabled = true }: { enabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnce(inputRef, enabled);
  return <input ref={inputRef} aria-label="Prompt" />;
}

describe('useAutoFocusOnce', () => {
  afterEach(() => {
    vi.mocked(window.matchMedia).mockReset();
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it('does not focus automatically below the md breakpoint', () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
      media: '(min-width: 768px)',
    } as MediaQueryList);

    render(<AutoFocusFixture />);

    expect(document.activeElement).not.toHaveAttribute('aria-label', 'Prompt');
  });

  it('focuses automatically at the md breakpoint and above', () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      media: '(min-width: 768px)',
    } as MediaQueryList);

    render(<AutoFocusFixture />);

    expect(document.activeElement).toHaveAttribute('aria-label', 'Prompt');
  });

  it('still focuses when delayed readiness enables it on desktop', () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      media: '(min-width: 768px)',
    } as MediaQueryList);

    const { rerender } = render(<AutoFocusFixture enabled={false} />);
    expect(document.activeElement).not.toHaveAttribute('aria-label', 'Prompt');

    act(() => rerender(<AutoFocusFixture />));

    expect(document.activeElement).toHaveAttribute('aria-label', 'Prompt');
  });
});
