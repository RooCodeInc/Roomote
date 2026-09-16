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
      expect(container).toHaveTextContent('name');
      expect(container).toHaveTextContent('98');
      expect(
        container.querySelector('[aria-hidden="true"]'),
      ).toBeInTheDocument();
      expect(
        container.querySelector('a, button, input'),
      ).not.toBeInTheDocument();
    },
  );

  it('renders no more than ten rows and eight fixed-width columns', () => {
    const content = Array.from({ length: 12 }, (_, row) =>
      Array.from({ length: 10 }, (_, column) => `${row}-${column}`).join(','),
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
      80,
    );
    expect(container.querySelector('.tabular-artifact-grid')).toHaveStyle({
      gridTemplateColumns: 'repeat(8, clamp(4rem, 30cqw, 5.25rem))',
    });
    expect(container).not.toHaveTextContent('10-0');
    expect(container).toHaveTextContent('0-7');
    expect(container).toHaveTextContent('9-7');
  });

  it('normalizes and truncates long cell text', () => {
    useArtifactByPathMock.mockReturnValue({
      data: {
        path: 'reports/results.csv',
        version: 1,
        contentType: 'text/csv',
        content:
          'name,notes\nAda,"line one\nline two"\nGrace,abcdefghijklmnopqrstuvwxyz0123456789',
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
    expect(container).toHaveTextContent('line one line two');
    expect(container).toHaveTextContent('abcdefghijklmnopqrstuvwx');
    expect(container).not.toHaveTextContent(
      'abcdefghijklmnopqrstuvwxyz0123456789',
    );
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

    expect(
      container.querySelector('.tabular-artifact-placeholder'),
    ).toHaveAttribute('data-state', state);
    expect(container.querySelectorAll('.tabular-artifact-cell')).toHaveLength(
      0,
    );
    expect(
      container.querySelectorAll('.tabular-artifact-placeholder > span'),
    ).toHaveLength(20);
    expect(container).not.toHaveTextContent('stale');
  });
});
