import { render } from '@testing-library/react';

const { useArtifactByPathMock } = vi.hoisted(() => ({
  useArtifactByPathMock: vi.fn(),
}));

vi.mock('@/hooks/use-artifact-by-path', () => ({
  useArtifactByPath: useArtifactByPathMock,
}));

import { TabularArtifactPreview } from './TabularArtifactPreview';

describe('TabularArtifactPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['reports/results.csv', 'text/csv', 'name,score\nAda,98'],
    [
      'reports/results.tsv',
      'text/tab-separated-values',
      'name\tscore\nAda\t98',
    ],
  ])(
    'renders an inert bounded preview for %s',
    (path, contentType, content) => {
      useArtifactByPathMock.mockReturnValue({
        data: { path, version: 2, contentType, content },
        isPending: false,
      });

      const { container } = render(
        <TabularArtifactPreview
          owner={{ taskId: 'task-1' }}
          path={path}
          version={2}
        />,
      );

      expect(useArtifactByPathMock).toHaveBeenCalledWith(
        { taskId: 'task-1' },
        path,
        2,
        'preview',
      );
      expect(container).not.toHaveTextContent('name');
      expect(container).not.toHaveTextContent('98');
      expect(
        container.querySelector('[aria-hidden="true"]'),
      ).toBeInTheDocument();
      expect(
        container.querySelector('a, button, input'),
      ).not.toBeInTheDocument();
    },
  );

  it('renders no more than six rows and five columns', () => {
    const content = Array.from({ length: 8 }, (_, row) =>
      Array.from({ length: 7 }, (_, column) => `${row}-${column}`).join(','),
    ).join('\n');
    useArtifactByPathMock.mockReturnValue({
      data: {
        path: 'reports/wide.csv',
        version: 1,
        contentType: 'text/csv',
        content,
      },
      isPending: false,
    });

    const { container } = render(
      <TabularArtifactPreview
        owner={{ taskId: 'task-1' }}
        path="reports/wide.csv"
        version={1}
      />,
    );

    expect(container.querySelectorAll('.tabular-artifact-cell')).toHaveLength(
      30,
    );
    expect(container.querySelector('.tabular-artifact-grid')).toHaveStyle({
      gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
    });
    expect(container).not.toHaveTextContent('5-4');
    expect(container).not.toHaveTextContent('6-0');
    expect(container).not.toHaveTextContent('0-5');
  });

  it('abstracts cell lengths without exposing their values', () => {
    useArtifactByPathMock.mockReturnValue({
      data: {
        path: 'reports/results.csv',
        version: 1,
        contentType: 'text/csv',
        content: 'a,,averyveryverylongvalue\none,two',
      },
      isPending: false,
    });

    const { container } = render(
      <TabularArtifactPreview
        owner={{ taskId: 'task-1' }}
        path="reports/results.csv"
        version={1}
      />,
    );
    const cells = container.querySelectorAll('.tabular-artifact-cell');

    expect(
      Array.from(cells, (cell) => cell.getAttribute('data-length')),
    ).toEqual(['short', 'empty', 'long', 'short', 'short', 'empty']);
    expect(container).not.toHaveTextContent('averyveryverylongvalue');
  });

  it.each([
    [true, 'loading'],
    [false, 'unavailable'],
  ])('shows an abstract fallback when loading is %s', (isPending, state) => {
    useArtifactByPathMock.mockReturnValue({
      data: {
        path: 'reports/other.csv',
        version: 1,
        contentType: 'text/csv',
        content: 'stale,value',
      },
      isPending,
    });

    const { container } = render(
      <TabularArtifactPreview
        owner={{ sessionId: '11111111-1111-4111-8111-111111111111' }}
        path="reports/results.csv"
        version={1}
      />,
    );

    expect(container.querySelector('.tabular-artifact-grid')).toHaveAttribute(
      'data-state',
      state,
    );
    expect(container.querySelectorAll('.tabular-artifact-cell')).toHaveLength(
      20,
    );
    expect(container).not.toHaveTextContent('stale');
  });
});
