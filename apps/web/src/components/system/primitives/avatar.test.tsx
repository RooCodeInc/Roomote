import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Avatar, getInitials } from './avatar';

describe('getInitials', () => {
  it('uses the first letters of up to two name parts', () => {
    expect(getInitials('Matt Rubens')).toBe('MR');
    expect(getInitials('Bruno')).toBe('B');
    expect(getInitials('  Ada  Lovelace  Byron ')).toBe('AL');
  });

  it('falls back to the first email character when name is missing', () => {
    expect(getInitials(null, 'matt@roomote.test')).toBe('M');
    expect(getInitials('   ', 'local@roomote.dev')).toBe('L');
  });

  it('returns an empty string when both name and email are missing', () => {
    expect(getInitials(null, null)).toBe('');
    expect(getInitials('', '')).toBe('');
  });
});

describe('Avatar', () => {
  it('renders initials when no image is available', () => {
    const { container } = render(
      <Avatar name="Matt Rubens" email="matt@roomote.test" alt="Matt Rubens" />,
    );

    expect(container.firstChild).toHaveAttribute('aria-label', 'Matt Rubens');
    expect(screen.getByText('MR')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('never renders the full name as visible fallback text', () => {
    render(<Avatar name="Local Admin" email="local@roomote.dev" />);

    expect(screen.getByText('LA')).toBeInTheDocument();
    expect(screen.queryByText('Local Admin')).not.toBeInTheDocument();
  });

  it('renders the image when a URL is provided', () => {
    render(
      <Avatar
        imageUrl="https://example.com/avatar.png"
        name="Matt Rubens"
        alt="Matt Rubens"
      />,
    );

    const image = document.querySelector('img');
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute('src', 'https://example.com/avatar.png');
    expect(image).toHaveAttribute('alt', '');
    expect(screen.queryByText('MR')).not.toBeInTheDocument();
  });

  it('falls back to initials when the image fails to load', () => {
    render(
      <Avatar
        imageUrl="https://example.com/missing.png"
        name="Matt Rubens"
        alt="Matt Rubens"
      />,
    );

    const image = document.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image!);

    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('MR')).toBeInTheDocument();
    expect(screen.queryByText('Matt Rubens')).not.toBeInTheDocument();
  });

  it('falls back to initials when the image is already complete and broken', async () => {
    const completeDescriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'complete',
    );
    const naturalWidthDescriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'naturalWidth',
    );

    Object.defineProperty(HTMLImageElement.prototype, 'complete', {
      configurable: true,
      get() {
        return true;
      },
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true,
      get() {
        return 0;
      },
    });

    try {
      render(
        <Avatar
          imageUrl="https://example.com/cached-404.png"
          name="Matt Rubens"
          alt="Matt Rubens"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('MR')).toBeInTheDocument();
      });
      expect(document.querySelector('img')).toBeNull();
      expect(screen.queryByText('Matt Rubens')).not.toBeInTheDocument();
    } finally {
      if (completeDescriptor) {
        Object.defineProperty(
          HTMLImageElement.prototype,
          'complete',
          completeDescriptor,
        );
      }
      if (naturalWidthDescriptor) {
        Object.defineProperty(
          HTMLImageElement.prototype,
          'naturalWidth',
          naturalWidthDescriptor,
        );
      }
    }
  });

  it('treats blank image URLs as missing and shows initials', () => {
    render(<Avatar imageUrl="   " name="Roomote Demo" />);

    expect(screen.getByText('RD')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
