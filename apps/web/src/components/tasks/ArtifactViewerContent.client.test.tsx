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
        text: `Build this ${window.location.origin}/task/task-1/artifacts/plans/widget-plan.md?v=1`,
      });
      expect(navigationState.push).toHaveBeenCalledWith(
        '/sessions/parent-session-id',
      );
    });
  });

  it('encodes artifact path segments in the sent URL', async () => {
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
        text: `Build this ${window.location.origin}/task/task-1/artifacts/plans/a%3F%23%20b.md?v=2`,
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
        text: `Build this ${window.location.origin}/task/task-1/artifacts/plans/widget-plan.md?v=1`,
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
