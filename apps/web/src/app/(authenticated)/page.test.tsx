import { renderToStaticMarkup } from 'react-dom/server';

const { mockHome } = vi.hoisted(() => ({
  mockHome: vi.fn(
    ({
      initialHeading,
      initialPlaceholderIndex,
    }: {
      initialHeading: string;
      initialPlaceholderIndex: number;
    }) => (
      <div
        data-home-heading={initialHeading}
        data-home-placeholder-index={initialPlaceholderIndex}
      />
    ),
  ),
}));

vi.mock('./home/Home', () => ({
  Home: mockHome,
}));

vi.mock('./home/promptPlaceholders', () => ({
  getRandomHomePromptPlaceholderIndex: () => 4,
}));

vi.mock('./home/headings', () => ({
  getRandomHomeHeading: () => 'My GPUs are warm and ready',
}));

import Page from './page';

describe('Authenticated home page', () => {
  it('passes the server-selected heading and placeholder index to Home', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(mockHome).toHaveBeenCalledWith(
      expect.objectContaining({
        initialHeading: 'My GPUs are warm and ready',
        initialPlaceholderIndex: 4,
      }),
      undefined,
    );
    expect(html).toContain('data-home-placeholder-index="4"');
    expect(html).toContain('data-home-heading="My GPUs are warm and ready"');
  });
});
