import { render } from '@testing-library/react';

import { FramedSurface } from './FramedSurface';

describe('FramedSurface', () => {
  it('lets explicit frame height utilities control the outer shell', () => {
    const { container } = render(
      <FramedSurface frameClassName="h-effective-viewport min-h-effective-viewport">
        <div>child</div>
      </FramedSurface>,
    );

    const frame = container.firstElementChild;
    const surface = frame?.firstElementChild;

    expect(frame).toHaveClass(
      'flex',
      'flex-1',
      'h-effective-viewport',
      'min-h-effective-viewport',
    );
    expect(frame).not.toHaveClass('h-full');
    expect(surface).toHaveClass('h-full', 'flex-1');
  });
});
