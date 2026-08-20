import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const { createTaskRunState, queryOptionsMock } = vi.hoisted(() => ({
  createTaskRunState: {
    mutate: vi.fn(),
    options: undefined as
      | {
          onSuccess: (
            result: {
              success: boolean;
              taskId?: string;
              error?: string;
            },
            variables: { sourceArtifactPath?: string },
          ) => void;
        }
      | undefined,
  },
  queryOptionsMock: vi.fn(() => ({})),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [] }),
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

vi.mock('@roomote/types', () => ({
  ALL_REPOSITORIES: [],
  DEFAULT_MANAGED_DEPLOYMENT_ACCESS: {
    state: 'active',
    reason: null,
    revision: 1,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    restrictionStartsAt: null,
    remediationUrl: null,
  },
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE:
    'New tasks are paused due to a billing issue. Please check billing.',
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifacts: {
      versions: {
        queryOptions: queryOptionsMock,
      },
    },
  }),
}));

vi.mock('@/lib', () => ({
  humanizeFilename: (value: string) => value,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(' '),
}));

vi.mock('@/hooks/tasks', () => ({
  useTask: () => ({ data: null }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    managedAccess: {
      state: 'active',
      reason: null,
      revision: 1,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      restrictionStartsAt: null,
      remediationUrl: null,
    },
  }),
}));

vi.mock('@/hooks/task-runs', () => ({
  useCreateStandardTaskRun: (options: typeof createTaskRunState.options) => {
    createTaskRunState.options = options;
    return {
      isPending: false,
      mutate: createTaskRunState.mutate,
    };
  },
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

vi.mock('./BuildArtifactConfirmDialog', () => ({
  BuildArtifactConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: (values: {
      repo: string;
      environmentId: string;
      modelId: string;
    }) => void;
  }) =>
    open ? (
      <button
        onClick={() =>
          onConfirm({
            repo: 'org/repo',
            environmentId: 'environment-1',
            modelId: 'model-1',
          })
        }
      >
        Confirm build
      </button>
    ) : null,
}));

import {
  ArtifactViewerContent,
  buildArtifactPlanDescription,
} from './ArtifactViewerContent';
import { toast } from 'sonner';

describe('ArtifactViewerContent', () => {
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

  it('hides the Build action when a markdown plan has no fetched content', () => {
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

    // A plan larger than the preview byte cap has no content to embed, so the
    // Build action must not be offered (it would silently produce an empty prompt).
    expect(screen.queryByText('Build this')).not.toBeInTheDocument();
  });

  it('shows build progress and links to the new task', () => {
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
    fireEvent.click(screen.getByText('Confirm build'));

    expect(toast.info).toHaveBeenCalledWith(
      'Starting new task to build plans/widget-plan.md',
    );

    createTaskRunState.options?.onSuccess(
      {
        success: true,
        taskId: 'new-task-id',
      },
      {
        sourceArtifactPath: 'plans/widget-plan.md',
      },
    );

    expect(toast.success).toHaveBeenCalledWith(
      'Building plans/widget-plan.md.',
      expect.objectContaining({ action: expect.anything() }),
    );

    const successToastOptions = vi.mocked(toast.success).mock.calls[0]?.[1];
    render(successToastOptions?.action as ReactElement);

    const viewTaskLink = screen.getByRole('link', { name: 'View task' });
    expect(viewTaskLink).toHaveAttribute('href', '/task/new-task-id');
    expect(viewTaskLink).toHaveAttribute('data-size', 'sm');
    expect(viewTaskLink).toHaveAttribute('data-variant', 'default');
  });

  describe('buildArtifactPlanDescription', () => {
    it('embeds the plan content directly into the build prompt', () => {
      const description = buildArtifactPlanDescription({
        artifactPath: 'plans/widget.md',
        artifactVersion: 2,
        artifactContent: '# Widget plan\n\nDo the thing.',
      });

      expect(description).toContain('Build the plan from plans/widget.md (v2)');
      expect(description).toContain('# Widget plan\n\nDo the thing.');
    });

    it('does not instruct the new task to download via manage_artifacts', () => {
      const description = buildArtifactPlanDescription({
        artifactPath: 'plans/widget.md',
        artifactVersion: 2,
        artifactContent: '# Widget plan',
      });

      // The plan content is embedded directly so the build is deterministic;
      // the prompt must not tell the task to fetch the plan via download.
      expect(description).not.toMatch(/manage_artifacts/);
      expect(description).not.toMatch(/download/i);
    });
  });
});
