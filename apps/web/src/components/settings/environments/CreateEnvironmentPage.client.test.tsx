import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SVGProps,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef, useImperativeHandle } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  mockStartDefinitionTask,
  mockCancelDefinitionTask,
  mockCreateEnvironment,
  mockValidateEnvironmentConfig,
  mockYamlEditorState,
} = vi.hoisted(() => {
  const initialConfig = {
    name: 'Warned Project',
    repositories: [{ repository: 'acme/api' }],
  };
  const editedConfig = {
    name: 'Edited Project',
    repositories: [{ repository: 'acme/web' }],
  };

  return {
    mockStartDefinitionTask: vi.fn().mockResolvedValue({
      taskId: 'task-1',
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    mockCancelDefinitionTask: vi.fn().mockResolvedValue({
      success: true,
    }),
    mockCreateEnvironment: vi.fn().mockResolvedValue({
      success: true,
      data: { id: 'env-1' },
    }),
    mockValidateEnvironmentConfig: vi.fn(),
    mockYamlEditorState: {
      initialConfig,
      editedConfig,
      currentConfig: initialConfig,
      reset() {
        this.currentConfig = this.initialConfig;
      },
    },
  };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/environments', () => ({
  useCreateEnvironment: () => ({
    mutateAsync: mockCreateEnvironment,
    isPending: false,
  }),
  useValidateEnvironmentConfig: () => ({
    mutateAsync: mockValidateEnvironmentConfig,
    isPending: false,
  }),
}));

vi.mock('@/hooks/source-control', () => ({
  useRepositories: () => ({
    data: [
      {
        id: 'repo-1',
        fullName: 'acme/api',
      },
      {
        id: 'repo-2',
        fullName: 'acme/web',
      },
    ],
    isPending: false,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    environments: {
      startDefinitionTask: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockStartDefinitionTask,
          ...options,
        }),
      },
      cancelDefinitionTask: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockCancelDefinitionTask,
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('@/app/(sandbox)/task/[taskId]/hooks', () => ({
  useTaskCompletionNotification: vi.fn(),
}));

vi.mock('./UpdateGitHubReposHint', () => ({
  UpdateGitHubReposHint: () => <div data-testid="update-github-repos-hint" />,
}));

vi.mock('./EnvironmentDefinitionAgentTask', () => ({
  EnvironmentDefinitionAgentTaskPanel: () => <div>task panel</div>,
  useEnvironmentDefinitionAgentState: () => ({
    succeeded: false,
    failed: false,
    session: {
      taskRun: {
        taskPhase: 'running',
      },
    },
    taskIsActive: true,
    matchingEnvironment: null,
  }),
}));

vi.mock('./YamlEnvironmentEditor', () => ({
  YamlEnvironmentEditor: forwardRef(function MockYamlEnvironmentEditor(
    props: {
      onSave: (config: unknown) => Promise<unknown>;
      onChange?: () => void;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      save: async () => {
        await props.onSave(mockYamlEditorState.currentConfig);
      },
    }));

    return (
      <button
        type="button"
        onClick={() => {
          mockYamlEditorState.currentConfig = mockYamlEditorState.editedConfig;
          props.onChange?.();
        }}
      >
        Mock edit YAML
      </button>
    );
  }),
}));

vi.mock('@/components/system', () => ({
  Alert: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  AlertDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  ArrowLeft: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Bot: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Card: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  CardContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Check: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...props}
    />
  ),
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
  HandMetal: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Loader2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ScrollArea: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

import { CreateEnvironmentPage } from './CreateEnvironmentPage';

describe('CreateEnvironmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockYamlEditorState.reset();
  });

  it('clears setup guidance when picking another repo after starting the agent', async () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByLabelText(/acme\/api/i));
    fireEvent.change(screen.getByPlaceholderText(/Optional agent guidance/i), {
      target: { value: 'Use the API service from the first repo set.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start Agent' }));

    await waitFor(() => {
      expect(mockStartDefinitionTask).toHaveBeenCalled();
    });
    expect(mockStartDefinitionTask.mock.calls[0]?.[0]).toEqual({
      repositoryIds: ['repo-1'],
      changeRequest: 'Use the API service from the first repo set.',
    });

    fireEvent.click(
      await screen.findByRole('button', { name: /Pick a different repo/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick another repo' }));

    await waitFor(() => {
      expect(mockCancelDefinitionTask).toHaveBeenCalled();
    });
    expect(mockCancelDefinitionTask.mock.calls[0]?.[0]).toEqual({
      taskId: 'task-1',
    });

    const guidanceTextarea = await screen.findByPlaceholderText(
      /Optional agent guidance/i,
    );
    expect(guidanceTextarea).toHaveValue('');

    fireEvent.click(screen.getByLabelText(/acme\/web/i));
    fireEvent.click(screen.getByRole('button', { name: 'Start Agent' }));

    await waitFor(() => {
      expect(mockStartDefinitionTask).toHaveBeenCalledTimes(2);
    });
    expect(mockStartDefinitionTask.mock.calls[1]?.[0]).toEqual({
      repositoryIds: ['repo-2'],
      changeRequest: undefined,
    });
  });

  it('clears stale continue-anyway state after yaml edits', async () => {
    mockValidateEnvironmentConfig
      .mockResolvedValueOnce({
        errors: [],
        warnings: ['Repository access warning'],
      })
      .mockResolvedValueOnce({
        errors: [],
        warnings: [],
      });

    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <CreateEnvironmentPage />
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Enter YAML directly/i }),
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Create Environment/i,
      }),
    );

    expect(
      await screen.findByRole('button', { name: /Continue anyway/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Mock edit YAML/i }));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Continue anyway/i }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Create Environment/i,
      }),
    );

    await waitFor(() => {
      expect(mockCreateEnvironment).toHaveBeenCalledWith({
        name: 'Edited Project',
        description: undefined,
        config: mockYamlEditorState.editedConfig,
      });
    });
  });
});
