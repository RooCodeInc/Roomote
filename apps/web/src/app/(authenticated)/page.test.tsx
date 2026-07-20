import { renderToStaticMarkup } from 'react-dom/server';

const {
  mockHome,
  mockResolveComputeProviderSelection,
  mockResolveDefaultComputeProvider,
  runtimeState,
} = vi.hoisted(() => ({
  mockResolveComputeProviderSelection: vi.fn().mockResolvedValue({
    defaultComputeProvider: 'modal',
    availableComputeProviders: ['modal', 'docker'],
  }),
  mockResolveDefaultComputeProvider: vi.fn().mockResolvedValue('roomote'),
  runtimeState: { cloudEnabled: false },
  mockHome: vi.fn(
    ({
      initialPlaceholderIndex,
      defaultComputeProvider,
      availableComputeProviders,
    }: {
      initialPlaceholderIndex: number;
      defaultComputeProvider: string;
      availableComputeProviders: string[];
    }) => (
      <div
        data-home-placeholder-index={initialPlaceholderIndex}
        data-home-compute-provider={defaultComputeProvider}
        data-home-available-providers={availableComputeProviders.join(',')}
      />
    ),
  ),
}));

vi.mock('./home/Home', () => ({
  Home: mockHome,
}));

vi.mock('@roomote/db/server', () => ({
  resolveComputeProviderSelection: mockResolveComputeProviderSelection,
  resolveDefaultComputeProvider: mockResolveDefaultComputeProvider,
}));

vi.mock('@/lib/server/env', () => ({
  Env: { R_CLOUD_ENABLED: 'cloud-setting' },
  isRoomoteCloudEnabled: () => runtimeState.cloudEnabled,
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
    runtimeState.cloudEnabled = false;
    mockHome.mockClear();
    mockResolveComputeProviderSelection.mockClear();
    mockResolveDefaultComputeProvider.mockClear();
  });

  it('passes the server-selected placeholder index to Home', async () => {
    const html = renderToStaticMarkup(await Page());

    expect(mockHome).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPlaceholderIndex: 4,
        defaultComputeProvider: 'modal',
        availableComputeProviders: ['modal', 'docker'],
      }),
      undefined,
    );
    expect(html).toContain('data-home-placeholder-index="4"');
    expect(html).toContain('data-home-compute-provider="modal"');
    expect(html).toContain('data-home-available-providers="modal,docker"');
  });

  it('does not scan picker options when cloud hides the provider picker', async () => {
    runtimeState.cloudEnabled = true;

    renderToStaticMarkup(await Page());

    expect(mockResolveDefaultComputeProvider).toHaveBeenCalledOnce();
    expect(mockResolveComputeProviderSelection).not.toHaveBeenCalled();
    expect(mockHome).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultComputeProvider: 'roomote',
        availableComputeProviders: ['roomote'],
      }),
      undefined,
    );
  });
});
