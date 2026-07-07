import { renderToStaticMarkup } from 'react-dom/server';

const { mockHome } = vi.hoisted(() => ({
  mockHome: vi.fn(
    ({
      initialPlaceholderIndex,
      defaultComputeProvider,
    }: {
      initialPlaceholderIndex: number;
      defaultComputeProvider: string;
    }) => (
      <div
        data-home-placeholder-index={initialPlaceholderIndex}
        data-home-compute-provider={defaultComputeProvider}
      />
    ),
  ),
}));

vi.mock('./home/Home', () => ({
  Home: mockHome,
}));

vi.mock('@roomote/db/server', () => ({
  resolveDefaultComputeProvider: vi.fn().mockResolvedValue('modal'),
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./home/promptPlaceholders', () => ({
  getRandomHomePromptPlaceholderIndex: () => 4,
}));

import Page from './page';

describe('Authenticated home page', () => {
  beforeEach(() => {
    mockHome.mockClear();
  });

  it('passes the server-selected placeholder index to Home', async () => {
    const html = renderToStaticMarkup(await Page());

    expect(mockHome).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPlaceholderIndex: 4,
        defaultComputeProvider: 'modal',
      }),
      undefined,
    );
    expect(html).toContain('data-home-placeholder-index="4"');
    expect(html).toContain('data-home-compute-provider="modal"');
  });
});
