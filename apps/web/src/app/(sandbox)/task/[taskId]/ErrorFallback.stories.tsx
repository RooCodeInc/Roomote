'use client';

import { useMemo, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { TRPCReactProvider } from '@/trpc/client';

import { SandboxStoreContext } from './hooks/SandboxProvider';
import type { SandboxConnectionFailureCategory } from './hooks/services/sandbox-live-connection-diagnostics';
import type { TaskSession } from './hooks/use-task-session';
import { createSandboxStore } from './hooks/use-sandbox-store';
import { ConnectionStatusBanner } from './ErrorFallback';

interface ConnectionBannerSandboxState {
  connected?: boolean;
  hasConnectedOnce?: boolean;
  connectionError?: boolean;
  connectionFailureCategory?: SandboxConnectionFailureCategory | null;
  reconnecting?: boolean;
}

type ConnectionBannerStoryHarnessProps = ComponentProps<
  typeof ConnectionStatusBanner
> & {
  sandbox?: ConnectionBannerSandboxState;
};

const baseSession: TaskSession = {
  artifacts: [],
  blank: false,
  taskRun: null,
  draftPrompt: null,
  harness: 'opencode-server',
  hasTransportError: false,
  transportErrorCategory: null,
  isLoading: false,
  isSessionLoading: false,
  isTokenLoading: false,
  prompt: null,
  refreshConnection: async () => null,
  sessionState: 'interactive',
  task: null,
  taskId: 'task-storybook-connection-banner',
  token: undefined,
};

function ConnectionBannerStoryHarness({
  sandbox,
  session,
}: ConnectionBannerStoryHarnessProps) {
  const store = useMemo(() => {
    const nextStore = createSandboxStore();

    nextStore.getState()._setConnected(sandbox?.connected ?? false);
    nextStore
      .getState()
      ._setHasConnectedOnce(sandbox?.hasConnectedOnce ?? false);
    nextStore.getState()._setConnectionError(sandbox?.connectionError ?? false);
    nextStore
      .getState()
      ._setConnectionFailureCategory(
        sandbox?.connectionFailureCategory ?? null,
      );
    nextStore.getState()._setReconnecting(sandbox?.reconnecting ?? false);

    return nextStore;
  }, [sandbox]);

  return (
    <SandboxStoreContext.Provider value={store}>
      <div className="bg-background min-h-screen p-6 text-foreground">
        <div className="overflow-hidden rounded-md border">
          <ConnectionStatusBanner session={session} />
        </div>
      </div>
    </SandboxStoreContext.Provider>
  );
}

const meta: Meta<typeof ConnectionBannerStoryHarness> = {
  title: 'Surfaces/Task Workspace/Connection Status Banner',
  component: ConnectionBannerStoryHarness,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <TRPCReactProvider>
        <Story />
      </TRPCReactProvider>
    ),
  ],
  args: {
    session: baseSession,
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const InitialConnecting: Story = {
  args: {
    sandbox: {
      connected: false,
      hasConnectedOnce: false,
      connectionError: false,
      reconnecting: true,
    },
  },
};

export const BackendUnavailable: Story = {
  args: {
    sandbox: {
      connected: false,
      hasConnectedOnce: false,
      connectionError: true,
      connectionFailureCategory: 'backend_unavailable',
      reconnecting: false,
    },
  },
};

export const ReconnectExhausted: Story = {
  args: {
    sandbox: {
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      connectionFailureCategory: 'client_reconnect_failed',
      reconnecting: false,
    },
  },
};

export const RefreshAuthFailed: Story = {
  args: {
    sandbox: {
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      connectionFailureCategory: 'auth_error',
      reconnecting: false,
    },
  },
};

export const TransportAuthFailed: Story = {
  args: {
    sandbox: {
      connected: false,
      hasConnectedOnce: false,
      connectionError: false,
      reconnecting: false,
    },
    session: {
      ...baseSession,
      hasTransportError: true,
      transportErrorCategory: 'auth_error',
    },
  },
};

export const FailureMatrix: Story = {
  render: () => (
    <div className="space-y-4 bg-background p-6 text-foreground">
      <div className="overflow-hidden rounded-md border">
        <ConnectionBannerStoryHarness
          session={baseSession}
          sandbox={{
            connected: false,
            hasConnectedOnce: false,
            connectionError: true,
            connectionFailureCategory: 'backend_unavailable',
            reconnecting: false,
          }}
        />
      </div>
      <div className="overflow-hidden rounded-md border">
        <ConnectionBannerStoryHarness
          session={baseSession}
          sandbox={{
            connected: false,
            hasConnectedOnce: true,
            connectionError: true,
            connectionFailureCategory: 'client_reconnect_failed',
            reconnecting: false,
          }}
        />
      </div>
      <div className="overflow-hidden rounded-md border">
        <ConnectionBannerStoryHarness
          session={baseSession}
          sandbox={{
            connected: false,
            hasConnectedOnce: true,
            connectionError: true,
            connectionFailureCategory: 'auth_error',
            reconnecting: false,
          }}
        />
      </div>
      <div className="overflow-hidden rounded-md border">
        <ConnectionBannerStoryHarness
          session={{
            ...baseSession,
            hasTransportError: true,
            transportErrorCategory: 'auth_error',
          }}
          sandbox={{
            connected: false,
            hasConnectedOnce: false,
            connectionError: false,
            reconnecting: false,
          }}
        />
      </div>
    </div>
  ),
};
