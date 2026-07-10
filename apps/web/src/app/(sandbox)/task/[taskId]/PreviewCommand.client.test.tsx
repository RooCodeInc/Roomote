import { render } from '@testing-library/react';

const { useRegisterCommandsMock } = vi.hoisted(() => ({
  useRegisterCommandsMock: vi.fn(),
}));

vi.mock('@/components/layout', () => ({
  useRegisterCommands: useRegisterCommandsMock,
}));

const {
  useTaskSidePanelMock,
  openPreviewViewMock,
  usePreviewPaneMock,
  openPreviewPaneMock,
  usePreviewUrlsMock,
  resolvePreviewTargetMock,
} = vi.hoisted(() => ({
  useTaskSidePanelMock: vi.fn(),
  openPreviewViewMock: vi.fn(),
  usePreviewPaneMock: vi.fn(),
  openPreviewPaneMock: vi.fn(),
  usePreviewUrlsMock: vi.fn(),
  resolvePreviewTargetMock: vi.fn(
    ({
      initialPaths,
      previewPath,
      previewServiceName,
      previewUrl,
      previewUrls,
      primaryPortName,
    }: {
      initialPaths?: Record<string, string>;
      previewPath: string | null;
      previewServiceName: string | null;
      previewUrl: string | null;
      previewUrls?: Record<string, string>;
      primaryPortName: string | null;
    }) => {
      if (previewServiceName && previewUrls?.[previewServiceName]) {
        const baseUrl = previewUrls[previewServiceName];
        const path = previewPath ?? initialPaths?.[previewServiceName] ?? '';

        return {
          previewServiceName,
          previewUrl: path ? `${baseUrl}${path}` : baseUrl,
        };
      }

      return {
        previewServiceName: primaryPortName,
        previewUrl,
      };
    },
  ),
}));

vi.mock('./hooks', () => ({
  useTaskSidePanel: useTaskSidePanelMock,
}));

vi.mock('./hooks/use-preview-pane', () => ({
  usePreviewPane: usePreviewPaneMock,
}));

vi.mock('./hooks/use-preview-urls', () => ({
  resolvePreviewTarget: resolvePreviewTargetMock,
  usePreviewUrls: usePreviewUrlsMock,
}));

import { PreviewCommand } from './PreviewCommand';

describe('PreviewCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskSidePanelMock.mockReturnValue({
      openPreviewView: openPreviewViewMock,
      previewPath: null,
      previewServiceName: null,
    });
    usePreviewPaneMock.mockReturnValue({
      openPreviewPane: openPreviewPaneMock,
    });
    usePreviewUrlsMock.mockReturnValue({
      initialPaths: {
        WEB: '/app',
        API: '/health',
      },
      previewUrl: 'https://preview.roomote.dev/app',
      previewUrls: {
        WEB: 'https://preview.roomote.dev',
        API: 'https://api.preview.roomote.dev',
      },
      primaryPortName: 'WEB',
    });
  });

  it('registers the Live Preview command when a preview URL is available', () => {
    render(<PreviewCommand taskRun={{ id: 123 } as never} asleep={false} />);

    expect(useRegisterCommandsMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'task-live-preview',
          label: 'Live Preview',
        }),
      ]),
    );
  });

  it('reuses the remembered preview target when running the command', () => {
    useTaskSidePanelMock.mockReturnValue({
      openPreviewView: openPreviewViewMock,
      previewPath: '/docs?tab=api',
      previewServiceName: 'API',
    });

    render(<PreviewCommand taskRun={{ id: 123 } as never} asleep={false} />);

    const livePreviewCommand = useRegisterCommandsMock.mock.calls[0]?.[0]?.find(
      (command: { id: string }) => command.id === 'task-live-preview',
    );

    livePreviewCommand?.action();

    expect(openPreviewPaneMock).toHaveBeenCalledWith(
      'https://api.preview.roomote.dev/docs?tab=api',
      123,
      'API',
    );
    expect(openPreviewViewMock).toHaveBeenCalledWith(
      'https://api.preview.roomote.dev/docs?tab=api',
      123,
      'API',
    );
  });
});
