import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const {
  navigationState,
  queryOptionsMock,
  forTaskQueryMock,
  replyMutationMock,
} = vi.hoisted(() => ({
  navigationState: {
    pathname: '/task/task-1/artifacts/plans/widget-plan.md',
    push: vi.fn(),
  },
  forTaskQueryMock: vi.fn(),
  replyMutationMock: vi.fn(),
  queryOptionsMock: vi.fn(() => ({})),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({ push: navigationState.push }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifacts: {
      versions: {
        queryOptions: queryOptionsMock,
      },
    },
  }),
  useTRPCClient: () => ({
    sessions: { forTask: { query: forTaskQueryMock } },
    fastSessions: { reply: { mutate: replyMutationMock } },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [] }),
  useMutation: (options: {
    mutationFn: () => Promise<unknown>;
    onSuccess: (result: unknown) => void;
    onError: (error: Error) => void;
  }) => ({
    isPending: false,
    mutate: () => {
      void options.mutationFn().then(options.onSuccess).catch(options.onError);
    },
  }),
}));

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  defaultRemarkPlugins: {},
}));

vi.mock('remark-breaks', () => ({
  default: () => null,
}));

vi.mock('@streamdown/cjk', () => ({
  cjk: {},
}));

vi.mock('@streamdown/code', () => ({
  code: {},
}));

vi.mock('@streamdown/math', () => ({
  math: {},
}));

vi.mock('@streamdown/mermaid', () => ({
  mermaid: {},
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/lib', () => ({
  humanizeFilename: (value: string) => value,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(' '),
}));

vi.mock('@/components/system', () => ({
  Download: () => <svg aria-hidden="true" />,
  Hammer: () => <svg aria-hidden="true" />,
  Copy: () => <svg aria-hidden="true" />,
  Check: () => <svg aria-hidden="true" />,
  Globe: () => <svg aria-hidden="true" />,
  LucideLink: () => <svg aria-hidden="true" />,
  Loader2Icon: () => <svg aria-hidden="true" />,
  ChevronLeftIcon: () => <svg aria-hidden="true" />,
  ChevronRight: () => <svg aria-hidden="true" />,
  Button: ({
    children,
    asChild,
    size,
    variant,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
    size?: string;
    variant?: string;
  }) =>
    asChild && isValidElement(children) ? (
      cloneElement(children as ReactElement<Record<string, unknown>>, {
        'data-size': size,
        'data-variant': variant ?? 'default',
      })
    ) : (
      <button {...props}>{children}</button>
    ),
  Switch: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    id: string;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
  Label: ({
    children,
    htmlFor,
    className,
  }: {
    children: ReactNode;
    htmlFor?: string;
    className?: string;
  }) => (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ),
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  MediaViewerImage: () => <div>image</div>,
  Table: ({ children, ...props }: React.ComponentProps<'table'>) => (
    <table {...props}>{children}</table>
  ),
  TableHeader: ({ children, ...props }: React.ComponentProps<'thead'>) => (
    <thead {...props}>{children}</thead>
  ),
  TableBody: ({ children, ...props }: React.ComponentProps<'tbody'>) => (
    <tbody {...props}>{children}</tbody>
  ),
  TableHead: ({ children, ...props }: React.ComponentProps<'th'>) => (
    <th {...props}>{children}</th>
  ),
  TableRow: ({ children, ...props }: React.ComponentProps<'tr'>) => (
    <tr {...props}>{children}</tr>
  ),
  TableCell: ({ children, ...props }: React.ComponentProps<'td'>) => (
    <td {...props}>{children}</td>
  ),
}));

vi.mock('@/components/ai-elements', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
  CustomLink: ({ children }: { children: ReactNode }) => <>{children}</>,
  CustomParagraph: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  remarkArtifactLinks: {},
  streamdownPlugins: {},
}));

import { ArtifactViewerContent } from './ArtifactViewerContent';
import { toast } from 'sonner';

describe('ArtifactViewerContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationState.pathname = '/task/task-1/artifacts/plans/widget-plan.md';
    forTaskQueryMock.mockResolvedValue({
      sessionId: 'parent-session-id',
      title: 'Parent Session',
    });
    replyMutationMock.mockResolvedValue({ success: true });
  });

  const navigationArtifact = {
    id: 'artifact-navigation',
    taskId: 'task-1',
    path: 'notes/navigation.md',
    version: 1,
    artifactType: 'general' as const,
    contentType: 'text/markdown',
    size: 128,
    createdAt: new Date('2026-05-22T00:00:00.000Z'),
    downloadUrl: 'https://example.test/navigation',
    content: 'Navigation content',
  };

  it('navigates with buttons and focus-scoped unmodified arrow keys', () => {
    const onPreviousArtifact = vi.fn();
    const onNextArtifact = vi.fn();
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={navigationArtifact}
        onPreviousArtifact={onPreviousArtifact}
        onNextArtifact={onNextArtifact}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Previous artifact' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next artifact' }));

    const viewer = screen.getByRole('region', { name: 'Artifact viewer' });
    expect(viewer).toHaveFocus();
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' });
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });

    expect(onPreviousArtifact).toHaveBeenCalledTimes(2);
    expect(onNextArtifact).toHaveBeenCalledTimes(2);
  });

  it('leaves modified keys, editable controls, media, and text selection alone', () => {
    const onPreviousArtifact = vi.fn();
    const onNextArtifact = vi.fn();
    const { rerender } = render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={navigationArtifact}
        onPreviousArtifact={onPreviousArtifact}
        onNextArtifact={onNextArtifact}
      />,
    );

    const viewer = screen.getByRole('region', { name: 'Artifact viewer' });
    fireEvent.keyDown(viewer, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyDown(screen.getByRole('checkbox'), { key: 'ArrowRight' });

    const getSelectionSpy = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ isCollapsed: false } as Selection);
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    getSelectionSpy.mockRestore();

    rerender(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          ...navigationArtifact,
          path: 'proof/demo.mp4',
          contentType: 'video/mp4',
          content: undefined,
        }}
        onPreviousArtifact={onPreviousArtifact}
        onNextArtifact={onNextArtifact}
      />,
    );
    fireEvent.keyDown(document.querySelector('video')!, { key: 'ArrowLeft' });

    expect(onPreviousArtifact).not.toHaveBeenCalled();
    expect(onNextArtifact).not.toHaveBeenCalled();
  });

  it('omits artifact navigation for a single item', () => {
    render(
      <ArtifactViewerContent taskId="task-1" artifact={navigationArtifact} />,
    );

    expect(
      screen.queryByRole('button', { name: 'Previous artifact' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next artifact' })).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Artifact viewer' }),
    ).not.toHaveAttribute('tabindex');
  });

  it.each([
    {
      label: 'normalized content type',
      path: 'reports/preview.bin',
      contentType: 'TEXT/HTML; charset=UTF-8',
    },
    {
      label: 'path extension',
      path: 'reports/preview.XHTML',
      contentType: 'application/octet-stream',
    },
  ])('detects HTML from $label', ({ path, contentType }) => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-html',
          taskId: 'task-1',
          path,
          version: 1,
          artifactType: 'general',
          contentType,
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/artifact',
          content: '<h1>HTML preview</h1>',
        }}
      />,
    );

    expect(screen.getByTitle(`Preview of ${path}`)).toBeInTheDocument();
  });

  it('renders HTML in a fully locked-down iframe by default', () => {
    const content = '<h1>Safe preview</h1><script>window.top.alert()</script>';

    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-html',
          taskId: 'task-1',
          path: 'reports/preview.html',
          version: 1,
          artifactType: 'general',
          contentType: 'text/html',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/preview.html',
          content,
        }}
      />,
    );

    const preview = screen.getByTitle('Preview of reports/preview.html');
    expect(preview).toHaveAttribute('srcdoc', content);
    expect(preview).toHaveAttribute('sandbox', '');
    expect(preview).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByText('Code')).toBeInTheDocument();
  });

  it('switches an HTML artifact between preview and code', () => {
    const content = '<main>HTML source</main>';

    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-html',
          taskId: 'task-1',
          path: 'reports/preview.htm',
          version: 1,
          artifactType: 'general',
          contentType: 'application/octet-stream',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/preview.htm',
          content,
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('Code'));

    expect(
      screen.queryByTitle('Preview of reports/preview.htm'),
    ).not.toBeInTheDocument();
    expect(screen.getByText(content)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Preview'));

    expect(
      screen.getByTitle('Preview of reports/preview.htm'),
    ).toBeInTheDocument();
  });

  it('resets HTML artifacts to preview when the path or version changes', () => {
    const createHtmlArtifact = (path: string, version: number) => ({
      id: 'artifact-html',
      taskId: 'task-1',
      path,
      version,
      artifactType: 'general' as const,
      contentType: 'text/html',
      size: 128,
      createdAt: new Date('2026-05-22T00:00:00.000Z'),
      downloadUrl: 'https://example.test/preview.html',
      content: `<main>${path} v${version}</main>`,
    });
    const { rerender } = render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={createHtmlArtifact('reports/first.html', 1)}
      />,
    );

    fireEvent.click(screen.getByLabelText('Code'));
    rerender(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={createHtmlArtifact('reports/second.html', 1)}
      />,
    );

    expect(
      screen.getByTitle('Preview of reports/second.html'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Code'));
    rerender(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={createHtmlArtifact('reports/second.html', 2)}
      />,
    );

    expect(
      screen.getByTitle('Preview of reports/second.html'),
    ).toBeInTheDocument();
  });

  it.each([
    {
      path: 'reports/data.bin',
      contentType: 'TEXT/CSV; charset=UTF-8',
      delimiter: ',',
    },
    {
      path: 'reports/data.TSV',
      contentType: 'application/octet-stream',
      delimiter: '\t',
    },
  ])(
    'renders $path as a table without consuming the first row as headers',
    ({ path, contentType, delimiter }) => {
      render(
        <ArtifactViewerContent
          taskId="task-1"
          artifact={{
            id: 'artifact-table',
            taskId: 'task-1',
            path,
            version: 1,
            artifactType: 'general',
            contentType,
            size: 128,
            createdAt: new Date('2026-05-22T00:00:00.000Z'),
            downloadUrl: 'https://example.test/data',
            content: `name${delimiter}value\nAda${delimiter}42`,
          }}
        />,
      );

      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();
      expect(table.parentElement).toHaveClass('overflow-x-auto');
      expect(
        screen.getByRole('columnheader', { name: 'Column 1' }),
      ).toBeVisible();
      expect(screen.getByRole('cell', { name: 'name' })).toBeVisible();
      expect(screen.getByRole('cell', { name: 'Ada' })).toBeVisible();
      expect(screen.getByLabelText('First row is a header')).not.toBeChecked();
      expect(screen.getByText('Source')).toBeVisible();
    },
  );

  it('uses the first parsed row as semantic column headers when enabled', () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/data.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 32,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/data.csv',
          content: 'name,value\nAda,42',
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('First row is a header'));

    expect(screen.getByRole('columnheader', { name: 'name' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'value' })).toBeVisible();
    expect(
      screen.queryByRole('cell', { name: 'name' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeVisible();
    expect(screen.getByRole('rowheader', { name: '2' })).toBeVisible();

    fireEvent.click(screen.getByLabelText('First row is a header'));

    expect(
      screen.getByRole('columnheader', { name: 'Column 1' }),
    ).toBeVisible();
    expect(screen.getByRole('cell', { name: 'name' })).toBeVisible();

    fireEvent.click(screen.getByLabelText('First row is a header'));
    fireEvent.click(screen.getByLabelText('Source'));

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'PRE' &&
          element.textContent === 'name,value\nAda,42',
      ),
    ).toBeVisible();
  });

  it('renders controlled header mode without a toolbar', () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        showToolbar={false}
        firstRowIsHeader
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/data.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 32,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/data.csv',
          content: 'name,value\nAda,42',
        }}
      />,
    );

    expect(
      screen.queryByLabelText('First row is a header'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'name' })).toBeVisible();
    expect(
      screen.queryByRole('cell', { name: 'name' }),
    ).not.toBeInTheDocument();
  });

  it('reports controlled header mode changes', () => {
    const onFirstRowIsHeaderChange = vi.fn();
    render(
      <ArtifactViewerContent
        taskId="task-1"
        firstRowIsHeader={false}
        onFirstRowIsHeaderChange={onFirstRowIsHeaderChange}
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/data.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 32,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/data.csv',
          content: 'name,value\nAda,42',
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('First row is a header'));

    expect(onFirstRowIsHeaderChange).toHaveBeenCalledWith(true);
  });

  it('renders table values as inert text and keeps source available', () => {
    const content = 'value\n<script>window.alert(1)</script>';
    const { container } = render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/data.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: content.length,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/data.csv',
          content,
        }}
      />,
    );

    expect(screen.getByText('<script>window.alert(1)</script>')).toBeVisible();
    expect(container.querySelector('script')).toBeNull();

    fireEvent.click(screen.getByLabelText('Source'));

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'PRE' && element.textContent === content,
      ),
    ).toBeVisible();
  });

  it('resets table view options when the path or version changes', () => {
    const createTableArtifact = (path: string, version: number) => ({
      id: 'artifact-table',
      taskId: 'task-1',
      path,
      version,
      artifactType: 'general' as const,
      contentType: 'text/csv',
      size: 32,
      createdAt: new Date('2026-05-22T00:00:00.000Z'),
      downloadUrl: 'https://example.test/data.csv',
      content: `path,version\n${path},${version}`,
    });
    const { rerender } = render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={createTableArtifact('reports/first.csv', 1)}
      />,
    );

    fireEvent.click(screen.getByLabelText('First row is a header'));
    fireEvent.click(screen.getByLabelText('Source'));
    rerender(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={createTableArtifact('reports/second.csv', 1)}
      />,
    );
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getByLabelText('First row is a header')).not.toBeChecked();
    expect(
      screen.getByRole('columnheader', { name: 'Column 1' }),
    ).toBeVisible();

    fireEvent.click(screen.getByLabelText('First row is a header'));
    fireEvent.click(screen.getByLabelText('Source'));
    rerender(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={createTableArtifact('reports/second.csv', 2)}
      />,
    );
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getByLabelText('First row is a header')).not.toBeChecked();
    expect(
      screen.getByRole('columnheader', { name: 'Column 1' }),
    ).toBeVisible();
  });

  it('supports header-only and ragged tables without changing parsed cells', () => {
    const { rerender } = render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/header-only.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 10,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/header-only.csv',
          content: 'name,value',
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('First row is a header'));

    expect(screen.getByRole('columnheader', { name: 'name' })).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(1);

    rerender(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/ragged.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 18,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/ragged.csv',
          content: 'name\nAda,42',
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText('First row is a header'));

    expect(screen.getByRole('columnheader', { name: 'name' })).toBeVisible();
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getByRole('cell', { name: '42' })).toBeVisible();
  });

  it('handles empty and malformed tables with source available', () => {
    const { rerender } = render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/empty.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 0,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/empty.csv',
          content: '',
        }}
      />,
    );

    expect(screen.getByText(/This table is empty/)).toBeVisible();
    expect(screen.getByText('Source')).toBeVisible();
    fireEvent.click(screen.getByLabelText('First row is a header'));
    expect(screen.getByText(/This table is empty/)).toBeVisible();

    rerender(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/malformed.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 14,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/malformed.csv',
          content: 'one,"two"three',
        }}
      />,
    );

    expect(screen.getByText(/Malformed quoted data/)).toBeVisible();
    expect(screen.getByRole('cell', { name: 'twothree' })).toBeVisible();
  });

  it('clearly reports table preview limits', () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-table',
          taskId: 'task-1',
          path: 'reports/large.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 1024,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/large.csv',
          content: Array.from({ length: 201 }, (_, index) => `${index}`).join(
            '\n',
          ),
        }}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Preview is limited to 200 rows, 50 columns, and 2,000 characters per cell.',
    );
    expect(screen.getAllByRole('row')).toHaveLength(201);
  });

  it('keeps non-HTML text artifacts in the existing code view', () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-text',
          taskId: 'task-1',
          path: 'reports/preview.html.txt',
          version: 1,
          artifactType: 'general',
          contentType: 'text/plain',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/preview.txt',
          content: 'Plain text content',
        }}
      />,
    );

    expect(screen.getByText('Plain text content')).toBeInTheDocument();
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    expect(screen.queryByText('Code')).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Preview of/)).not.toBeInTheDocument();
  });

  it('does not render the internal artifact type in the toolbar', () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-1',
          taskId: 'task-1',
          path: 'proofs/capture.md',
          version: 3,
          artifactType: 'visual-proof',
          contentType: 'text/markdown',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/artifact.md',
          content: '# Visual proof',
        }}
      />,
    );

    expect(queryOptionsMock).toHaveBeenCalledWith({
      path: 'proofs/capture.md',
      taskId: 'task-1',
    });

    expect(screen.getByText('Raw')).toBeInTheDocument();

    expect(screen.queryByText('Type: visual-proof')).not.toBeInTheDocument();
  });

  it('keeps universal toolbar actions mounted and disabled while loading', () => {
    render(<ArtifactViewerContent taskId="task-1" artifact={null} isLoading />);

    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeDisabled();
    expect(screen.getByLabelText('Loading artifact')).toBeVisible();
  });

  it('labels the enabled download link without changing native download behavior', () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-1',
          taskId: 'task-1',
          path: 'reports/data.csv',
          version: 1,
          artifactType: 'general',
          contentType: 'text/csv',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/data.csv',
          content: 'name,value\nalpha,1',
        }}
      />,
    );

    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      'https://example.test/data.csv',
    );
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
    );
  });

  it('offers the Build action when a markdown plan has no fetched content', () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-2',
          taskId: 'task-1',
          path: 'plans/huge.md',
          version: 1,
          artifactType: 'plan',
          contentType: 'text/markdown',
          size: 2_000_000,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/huge.md',
          content: undefined,
        }}
      />,
    );

    expect(screen.getByText('Build this')).toBeInTheDocument();
  });

  it('sends the artifact URL to its parent Session and opens that Session', async () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-2',
          taskId: 'task-1',
          path: 'plans/widget-plan.md',
          version: 1,
          artifactType: 'plan',
          contentType: 'text/markdown',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/widget-plan.md',
          content: '# Widget plan',
        }}
      />,
    );

    fireEvent.click(screen.getByText('Build this'));

    await waitFor(() => {
      expect(forTaskQueryMock).toHaveBeenCalledWith({ taskId: 'task-1' });
      expect(replyMutationMock).toHaveBeenCalledWith({
        sessionId: 'parent-session-id',
        text: `Build this ${window.location.origin}/task/task-1/artifacts?path=plans%2Fwidget-plan.md&v=1`,
      });
      expect(navigationState.push).toHaveBeenCalledWith(
        '/sessions/parent-session-id',
      );
    });
  });

  it('sends a Session-owned artifact back into the same Session', async () => {
    render(
      <ArtifactViewerContent
        owner={{ sessionId: '11111111-1111-4111-8111-111111111111' }}
        artifact={{
          id: 'artifact-2',
          taskId: null,
          sessionId: '11111111-1111-4111-8111-111111111111',
          path: 'plans/session-plan.md',
          version: 1,
          artifactType: 'plan',
          contentType: 'text/markdown',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/session-plan.md',
          content: '# Session plan',
        }}
      />,
    );

    fireEvent.click(screen.getByText('Build this'));

    await waitFor(() => {
      expect(forTaskQueryMock).not.toHaveBeenCalled();
      expect(replyMutationMock).toHaveBeenCalledWith({
        sessionId: '11111111-1111-4111-8111-111111111111',
        text: 'Build the plans/session-plan.md artifact (v1) created in this Session.',
      });
    });
  });

  it('preserves artifact paths in the sent URL', async () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-2',
          taskId: 'task-1',
          path: 'plans/a?# b.md',
          version: 2,
          artifactType: 'plan',
          contentType: 'text/markdown',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/widget-plan.md',
          content: '# Widget plan',
        }}
      />,
    );

    fireEvent.click(screen.getByText('Build this'));

    await waitFor(() => {
      expect(replyMutationMock).toHaveBeenCalledWith({
        sessionId: 'parent-session-id',
        text: `Build this ${window.location.origin}/task/task-1/artifacts?path=plans%2Fa%3F%23+b.md&v=2`,
      });
    });
  });

  it('preserves legacy dot-only path segments in the sent URL', async () => {
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-2',
          taskId: 'task-1',
          path: 'plans/./draft.md',
          version: 2,
          artifactType: 'plan',
          contentType: 'text/markdown',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/widget-plan.md',
          content: '# Widget plan',
        }}
      />,
    );

    fireEvent.click(screen.getByText('Build this'));

    await waitFor(() => {
      expect(replyMutationMock).toHaveBeenCalledWith({
        sessionId: 'parent-session-id',
        text: `Build this ${window.location.origin}/task/task-1/artifacts?path=plans%2F.%2Fdraft.md&v=2`,
      });
    });
  });

  it('does not navigate when the parent Session is already visible', async () => {
    navigationState.pathname = '/sessions/parent-session-id';
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-2',
          taskId: 'task-1',
          path: 'plans/widget-plan.md',
          version: 1,
          artifactType: 'plan',
          contentType: 'text/markdown',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/widget-plan.md',
          content: '# Widget plan',
        }}
      />,
    );

    fireEvent.click(screen.getByText('Build this'));

    await waitFor(() => {
      expect(replyMutationMock).toHaveBeenCalledWith({
        sessionId: 'parent-session-id',
        text: `Build this ${window.location.origin}/task/task-1/artifacts?path=plans%2Fwidget-plan.md&v=1`,
      });
    });
    expect(navigationState.push).not.toHaveBeenCalled();
  });

  it('reports when the artifact task has no parent Session', async () => {
    forTaskQueryMock.mockResolvedValue(null);
    render(
      <ArtifactViewerContent
        taskId="task-1"
        artifact={{
          id: 'artifact-2',
          taskId: 'task-1',
          path: 'plans/widget-plan.md',
          version: 1,
          artifactType: 'plan',
          contentType: 'text/markdown',
          size: 128,
          createdAt: new Date('2026-05-22T00:00:00.000Z'),
          downloadUrl: 'https://example.test/widget-plan.md',
          content: '# Widget plan',
        }}
      />,
    );

    fireEvent.click(screen.getByText('Build this'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'The task that created this artifact is not attached to a Session.',
      );
    });
    expect(replyMutationMock).not.toHaveBeenCalled();
    expect(navigationState.push).not.toHaveBeenCalled();
  });
});
