import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactElement,
  ReactNode,
} from 'react';
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import YAML from 'yaml';

import { configToYaml } from './yaml-utils';

const {
  mockStartDefinitionTask,
  mockConfigVersionsState,
  mockGetConfigVersion,
  mockRouterPush,
  mockUpdateEnvironment,
  mockValidateEnvironmentConfig,
  mockYamlEditorState,
  mockEnvironment,
  mockRepositories,
} = vi.hoisted(() => {
  const initialConfig = {
    name: 'Warned Project',
    description: 'Original description',
    repositories: [{ repository: 'acme/api' }],
  };
  const editedConfig = {
    name: 'Edited Project',
    description: 'Updated description',
    repositories: [{ repository: 'acme/web' }],
  };
  const historicalConfig = {
    name: 'Historical Project',
    description: 'Historical description',
    repositories: [{ repository: 'acme/api' }],
  };
  const baselineVersions = [
    {
      version: 2,
      name: 'Edited Project',
      description: 'Updated description',
      source: 'user',
      createdByUserId: 'user-1',
      createdByUserName: 'Test User',
      createdAt: new Date('2026-03-24T00:00:00.000Z'),
    },
    {
      version: 1,
      name: 'Historical Project',
      description: 'Historical description',
      source: 'user',
      createdByUserId: 'user-1',
      createdByUserName: 'Test User',
      createdAt: new Date('2026-03-23T00:00:00.000Z'),
    },
  ];
  const versionDetails = {
    1: {
      ...baselineVersions[1],
      config: historicalConfig,
    },
    2: {
      ...baselineVersions[0],
      config: editedConfig,
    },
  } as const;

  return {
    mockStartDefinitionTask: vi.fn().mockResolvedValue({
      taskId: 'task-1',
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    mockConfigVersionsState: {
      current: baselineVersions,
      reset() {
        this.current = baselineVersions;
      },
    },
    mockGetConfigVersion: vi.fn(
      ({ version }: { environmentId: string; version: number }) =>
        Promise.resolve(versionDetails[version as 1 | 2] ?? null),
    ),
    mockRouterPush: vi.fn(),
    mockUpdateEnvironment: vi.fn().mockResolvedValue({ success: true }),
    mockValidateEnvironmentConfig: vi.fn(),
    mockEnvironment: {
      id: 'env-1',
      name: 'Warned Project',
      description: 'Original description',
      config: initialConfig,
    },
    mockRepositories: [
      {
        id: 'repo-1',
        fullName: 'acme/api',
      },
      {
        id: 'repo-2',
        fullName: 'acme/web',
      },
    ],
    mockYamlEditorState: {
      initialConfig,
      editedConfig,
      nextMountId: 0,
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/hooks/environments', () => ({
  useEnvironment: () => ({
    data: mockEnvironment,
    isPending: false,
  }),
  useUpdateEnvironment: () => ({
    mutateAsync: mockUpdateEnvironment,
    isPending: false,
  }),
  useValidateEnvironmentConfig: () => ({
    mutateAsync: mockValidateEnvironmentConfig,
    isPending: false,
  }),
}));

vi.mock('@/hooks/source-control', () => ({
  useRepositories: () => ({
    data: mockRepositories,
    isPending: false,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    environments: {
      list: {
        queryKey: () => ['environments.list'],
      },
      byId: {
        queryKey: ({ id }: { id: string }) => ['environments.byId', id],
      },
      listConfigVersions: {
        queryKey: ({ environmentId }: { environmentId: string }) => [
          'environments.listConfigVersions',
          environmentId,
        ],
        queryOptions: ({ environmentId }: { environmentId: string }) => ({
          queryKey: ['environments.listConfigVersions', environmentId],
          queryFn: () => Promise.resolve(mockConfigVersionsState.current),
        }),
      },
      getConfigVersion: {
        queryOptions: ({
          environmentId,
          version,
        }: {
          environmentId: string;
          version: number;
        }) => ({
          queryKey: ['environments.getConfigVersion', environmentId, version],
          queryFn: () => mockGetConfigVersion({ environmentId, version }),
        }),
      },
      startDefinitionTask: {
        mutationOptions: (options = {}) => ({
          mutationFn: mockStartDefinitionTask,
          ...options,
        }),
      },
    },
  }),
}));

vi.mock('./UpdateGitHubReposHint', () => ({
  UpdateGitHubReposHint: () => <div data-testid="update-github-repos-hint" />,
}));

vi.mock('./YamlEnvironmentEditor', () => ({
  YamlEnvironmentEditor: forwardRef(function MockYamlEnvironmentEditor(
    props: {
      initialConfig?: Record<string, unknown>;
      initialYamlContent?: string;
      onSave: (config: unknown) => Promise<unknown>;
      onChange?: () => void;
    },
    ref,
  ) {
    const [mountId] = useState(() => ++mockYamlEditorState.nextMountId);
    const [yamlContent, setYamlContent] = useState(
      props.initialYamlContent ??
        configToYaml(
          (props.initialConfig as typeof mockYamlEditorState.initialConfig) ??
            mockYamlEditorState.initialConfig,
        ),
    );

    useEffect(() => {
      setYamlContent(
        props.initialYamlContent ??
          configToYaml(
            (props.initialConfig as typeof mockYamlEditorState.initialConfig) ??
              mockYamlEditorState.initialConfig,
          ),
      );
    }, [props.initialConfig, props.initialYamlContent]);

    useImperativeHandle(ref, () => ({
      save: async () => {
        await props.onSave(YAML.parse(yamlContent));
      },
    }));

    return (
      <>
        <div data-testid="yaml-editor-mount-id">{mountId}</div>
        <textarea aria-label="YAML content" readOnly value={yamlContent} />
        <button
          type="button"
          onClick={() => {
            setYamlContent(configToYaml(mockYamlEditorState.editedConfig));
            props.onChange?.();
          }}
        >
          Mock edit YAML
        </button>
      </>
    );
  }),
}));

vi.mock('@/components/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/system')>();

  return {
    ...actual,
    Button: ({
      children,
      asChild = false,
      ...props
    }: {
      children: ReactNode;
      asChild?: boolean;
    } & ButtonHTMLAttributes<HTMLButtonElement>) => {
      if (asChild && isValidElement(children)) {
        return cloneElement(
          children as ReactElement<Record<string, unknown>>,
          props as Record<string, unknown>,
        );
      }

      return (
        <button type={props.type ?? 'button'} {...props}>
          {children}
        </button>
      );
    },
    Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
      open ? <div>{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    DialogHeader: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    DialogFooter: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

import { EditEnvironmentPage } from './EditEnvironmentPage';

describe('EditEnvironmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigVersionsState.reset();
    mockYamlEditorState.nextMountId = 0;
  });

  it('links back to the environments settings page', () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <EditEnvironmentPage environmentId="env-1" />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText('Back to environments')).toHaveAttribute(
      'href',
      '/settings/environments',
    );
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
        <EditEnvironmentPage environmentId="env-1" />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(
      await screen.findByRole('button', { name: /Continue anyway/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Mock edit YAML/i }));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Continue anyway/i }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(mockUpdateEnvironment).toHaveBeenCalledWith({
        id: 'env-1',
        name: 'Edited Project',
        description: 'Updated description',
        config: mockYamlEditorState.editedConfig,
      });
    });
  });

  it('loads a saved version into the YAML editor and restores the current config', async () => {
    mockValidateEnvironmentConfig.mockResolvedValue({
      errors: [],
      warnings: [],
    });
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <EditEnvironmentPage environmentId="env-1" />
      </QueryClientProvider>,
    );

    const versionSelect = await screen.findByRole('combobox', {
      name: /Version/i,
    });
    expect(screen.getByRole('textbox', { name: /YAML content/i })).toHaveValue(
      configToYaml(mockEnvironment.config),
    );

    fireEvent.change(versionSelect, { target: { value: '2' } });

    await waitFor(() => {
      expect(mockGetConfigVersion).toHaveBeenCalledWith({
        environmentId: 'env-1',
        version: 2,
      });
      expect(
        screen.getByRole('textbox', { name: /YAML content/i }),
      ).toHaveValue(configToYaml(mockYamlEditorState.editedConfig));
    });

    fireEvent.change(screen.getByRole('combobox', { name: /Version/i }), {
      target: { value: '1' },
    });

    await waitFor(() => {
      expect(mockGetConfigVersion).toHaveBeenCalledWith({
        environmentId: 'env-1',
        version: 1,
      });
      expect(
        screen.getByRole('textbox', { name: /YAML content/i }),
      ).toHaveValue(
        configToYaml({
          name: 'Historical Project',
          description: 'Historical description',
          repositories: [{ repository: 'acme/api' }],
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(mockUpdateEnvironment).toHaveBeenCalledWith({
        id: 'env-1',
        name: 'Historical Project',
        description: 'Historical description',
        config: {
          name: 'Historical Project',
          description: 'Historical description',
          repositories: [{ repository: 'acme/api' }],
        },
      });
    });

    fireEvent.change(screen.getByRole('combobox', { name: /Version/i }), {
      target: { value: 'current' },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: /YAML content/i }),
      ).toHaveValue(configToYaml(mockEnvironment.config));
    });
  });

  it('remounts the editor after saving a loaded historical version', async () => {
    mockValidateEnvironmentConfig.mockResolvedValue({
      errors: [],
      warnings: [],
    });
    const onUpdated = vi.fn();

    const queryClient = new QueryClient();
    const refetchQueriesSpy = vi
      .spyOn(queryClient, 'refetchQueries')
      .mockImplementation(async (filters) => {
        const queryKey = filters?.queryKey;
        if (
          queryKey &&
          JSON.stringify(queryKey) ===
            JSON.stringify(['environments.byId', 'env-1'])
        ) {
          mockEnvironment.name = 'Historical Project';
          mockEnvironment.description = 'Historical description';
          mockEnvironment.config = {
            name: 'Historical Project',
            description: 'Historical description',
            repositories: [{ repository: 'acme/api' }],
          };
        }

        return undefined;
      });
    mockUpdateEnvironment.mockResolvedValueOnce({ success: true });

    render(
      <QueryClientProvider client={queryClient}>
        <EditEnvironmentPage environmentId="env-1" onUpdated={onUpdated} />
      </QueryClientProvider>,
    );

    fireEvent.change(
      await screen.findByRole('combobox', { name: /Version/i }),
      {
        target: { value: '1' },
      },
    );

    await waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: /YAML content/i }),
      ).toHaveValue(
        configToYaml({
          name: 'Historical Project',
          description: 'Historical description',
          repositories: [{ repository: 'acme/api' }],
        }),
      );
    });

    const mountIdBeforeSave = Number(
      screen.getByTestId('yaml-editor-mount-id').textContent,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(mockUpdateEnvironment).toHaveBeenCalledWith({
        id: 'env-1',
        name: 'Historical Project',
        description: 'Historical description',
        config: {
          name: 'Historical Project',
          description: 'Historical description',
          repositories: [{ repository: 'acme/api' }],
        },
      });
      expect(screen.getByRole('combobox', { name: /Version/i })).toHaveValue(
        'current',
      );
      expect(
        Number(screen.getByTestId('yaml-editor-mount-id').textContent),
      ).toBeGreaterThan(mountIdBeforeSave);
      expect(onUpdated).not.toHaveBeenCalled();
      expect(refetchQueriesSpy).toHaveBeenCalledWith({
        queryKey: ['environments.byId', 'env-1'],
      });
      expect(
        screen.getByRole('textbox', { name: /YAML content/i }),
      ).toHaveValue(
        configToYaml({
          name: 'Historical Project',
          description: 'Historical description',
          repositories: [{ repository: 'acme/api' }],
        }),
      );
    });
  });

  it('hides the version selector when there are fewer than two saved versions', async () => {
    mockConfigVersionsState.current = [mockConfigVersionsState.current[0]!];
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <EditEnvironmentPage environmentId="env-1" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole('combobox', { name: /Version/i }),
      ).not.toBeInTheDocument();
    });
  });

  it('starts an environment edit task and opens it in the task view', async () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <EditEnvironmentPage environmentId="env-1" />
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: /Use the Onboarding Agent/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Start Agent/i }));

    await waitFor(() => {
      expect(mockStartDefinitionTask).toHaveBeenCalled();
    });
    expect(mockStartDefinitionTask.mock.calls[0]?.[0]).toEqual({
      repositoryIds: ['repo-1'],
      environmentId: 'env-1',
      changeRequest: undefined,
    });
    expect(mockRouterPush).toHaveBeenCalledWith('/task/task-1');
  });
});
