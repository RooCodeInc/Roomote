import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const hoisted = vi.hoisted(() => {
  const authState = {
    user: { userId: 'user-1', orgId: 'org-1' } as {
      userId: string;
      orgId: string;
    } | null,
  };
  const formState = {
    currentModelId: '',
  };

  return {
    authState,
    formState,
    useFormMock: vi.fn(() => ({
      handleSubmit: (handler: (values: { repository: string }) => void) => () =>
        handler({ repository: 'org/repo' }),
      getValues: (field?: string) =>
        field === 'modelId' ? formState.currentModelId : undefined,
      setValue: (field: string, value: string) => {
        if (field === 'modelId') {
          formState.currentModelId = value;
        }
      },
      watch: (field: string) =>
        field === 'modelId' ? formState.currentModelId : undefined,
    })),
    useWorkspaceStorageMock: vi.fn(() => ({
      workspace: { workspace: { type: 'auto' as const } },
    })),
    useLaunchTaskModelsMock: vi.fn(() => ({
      data: {
        defaultModelId: 'openrouter/openai/gpt-5.4',
        models: [
          {
            id: 'openrouter/openai/gpt-5.4',
            displayName: 'GPT 5.4',
            isDefault: true,
          },
        ],
      },
      isPending: false,
    })),
  };
});

vi.mock('react-hook-form', () => ({
  useForm: hoisted.useFormMock,
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => vi.fn(),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({
    isSignedIn: !!hoisted.authState.user,
    user: hoisted.authState.user,
  }),
}));

vi.mock('@/hooks/useWorkspaceStorage', () => ({
  useWorkspaceStorage: hoisted.useWorkspaceStorageMock,
}));

vi.mock('@/hooks/task-models/useLaunchTaskModels', () => ({
  useLaunchTaskModels: hoisted.useLaunchTaskModelsMock,
}));

vi.mock('@/components/system', () => ({
  Loader2: () => <svg aria-hidden="true" />,
  Button: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Form: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('./SelectWorkspace', () => ({
  SelectWorkspace: () => <div>Workspace selector</div>,
}));

vi.mock('./ModelSelect', () => ({
  ModelSelect: () => <div>Model selector</div>,
}));

import { BuildArtifactConfirmDialog } from './BuildArtifactConfirmDialog';

describe('BuildArtifactConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.authState.user = { userId: 'user-1', orgId: 'org-1' };
    hoisted.formState.currentModelId = '';
  });

  it('does not mount auth-dependent form state while closed', () => {
    const { container } = render(
      <BuildArtifactConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        artifactName="demo plan"
        artifactVersion={1}
        onConfirm={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(hoisted.useWorkspaceStorageMock).not.toHaveBeenCalled();
    expect(hoisted.useFormMock).not.toHaveBeenCalled();
  });

  it('does not render when auth context is unavailable', () => {
    hoisted.authState.user = null;

    const { container } = render(
      <BuildArtifactConfirmDialog
        open
        onOpenChange={vi.fn()}
        artifactName="demo plan"
        artifactVersion={1}
        onConfirm={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(hoisted.useWorkspaceStorageMock).not.toHaveBeenCalled();
    expect(hoisted.useFormMock).not.toHaveBeenCalled();
  });

  it('mounts the workspace form when opened with an authorized user', () => {
    render(
      <BuildArtifactConfirmDialog
        open
        onOpenChange={vi.fn()}
        artifactName="demo plan"
        artifactVersion={1}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText('Build this plan')).toBeInTheDocument();
    expect(screen.getByText('Model selector')).toBeInTheDocument();
    expect(hoisted.useWorkspaceStorageMock).toHaveBeenCalledTimes(1);
    expect(hoisted.useFormMock).toHaveBeenCalledTimes(1);
  });
});
