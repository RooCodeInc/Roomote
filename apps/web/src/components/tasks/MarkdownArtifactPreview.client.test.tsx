import { render } from '@testing-library/react';

const { useArtifactByPathMock } = vi.hoisted(() => ({
  useArtifactByPathMock: vi.fn(),
}));

vi.mock('@/hooks/use-artifact-by-path', () => ({
  useArtifactByPath: useArtifactByPathMock,
}));

import { MarkdownArtifactPreview } from './MarkdownArtifactPreview';

describe('MarkdownArtifactPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Markdown formatting without interactive links', () => {
    useArtifactByPathMock.mockReturnValue({
      data: {
        path: 'plans/launch.md',
        version: 3,
        content:
          '# Launch plan\n\n- Ship the **preview**\n- Read [details](https://example.test)',
      },
      isPending: false,
    });

    const { container } = render(
      <MarkdownArtifactPreview
        owner={{ taskId: 'task-1' }}
        path="plans/launch.md"
        version={3}
      />,
    );

    expect(useArtifactByPathMock).toHaveBeenCalledWith(
      { taskId: 'task-1' },
      'plans/launch.md',
      3,
      'preview',
    );
    expect(container.querySelector('h1')).toHaveTextContent('Launch plan');
    expect(container.querySelector('ul')).toBeInTheDocument();
    expect(container).toHaveTextContent('preview');
    expect(container.querySelector('a')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('details');
  });

  it('shows a paper placeholder when preview content is unavailable', () => {
    useArtifactByPathMock.mockReturnValue({
      data: null,
      isPending: false,
    });

    const { container } = render(
      <MarkdownArtifactPreview
        owner={{ sessionId: '11111111-1111-4111-8111-111111111111' }}
        path="notes/decision.md"
        version={1}
      />,
    );

    expect(
      container.querySelector('.markdown-artifact-placeholder'),
    ).toBeInTheDocument();
  });

  it('renders an incomplete Markdown prefix without creating an interactive element', () => {
    useArtifactByPathMock.mockReturnValue({
      data: {
        path: 'plans/truncated.md',
        version: 1,
        content: '# Partial plan\n\n[unfinished link](https://example.test',
      },
      isPending: false,
    });

    const { container } = render(
      <MarkdownArtifactPreview
        owner={{ taskId: 'task-1' }}
        path="plans/truncated.md"
        version={1}
      />,
    );

    expect(container).toHaveTextContent('Partial plan');
    expect(container.querySelector('a')).not.toBeInTheDocument();
  });
});
