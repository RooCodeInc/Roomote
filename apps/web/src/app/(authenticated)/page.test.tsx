import { renderToStaticMarkup } from 'react-dom/server';

const { mockHome } = vi.hoisted(() => ({
  mockHome: vi.fn(
    ({ initialPlaceholderIndex }: { initialPlaceholderIndex: number }) => (
      <div data-home-placeholder-index={initialPlaceholderIndex} />
    ),
  ),
}));

vi.mock('./home/Home', () => ({
  Home: mockHome,
}));

vi.mock('./home/promptPlaceholders', () => ({
  getRandomHomePromptPlaceholderIndex: () => 4,
}));

import Page from './page';

describe('Authenticated home page', () => {
  it('passes the server-selected placeholder index to Home', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(mockHome).toHaveBeenCalledWith(
      expect.objectContaining({ initialPlaceholderIndex: 4 }),
      undefined,
    );
    expect(html).toContain('data-home-placeholder-index="4"');
  });
});
