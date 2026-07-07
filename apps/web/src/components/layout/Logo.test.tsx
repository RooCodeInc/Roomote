import type { ImgHTMLAttributes } from 'react';
import { render, screen } from '@testing-library/react';

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('next/image', () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} />;
  },
}));

import { Logo } from './Logo';

describe('Logo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the default Roomote brand mark for normal sessions', () => {
    render(<Logo />);

    expect(screen.getByAltText('Roomote logo')).toHaveAttribute(
      'src',
      '/logos/r.svg',
    );
  });
});
