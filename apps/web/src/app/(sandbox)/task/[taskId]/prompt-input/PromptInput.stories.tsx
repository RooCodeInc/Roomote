'use client';

import { useMemo, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { TaskPhase } from '@roomote/types';

import { TRPCReactProvider } from '@/trpc/client';

import type { SandboxClient } from '../types';
import { SandboxStoreContext } from '../hooks/SandboxProvider';
import { createSandboxStore } from '../hooks/use-sandbox-store';
import { PromptInput } from './PromptInput';

interface PromptInputSandboxState {
  connected?: boolean;
  connectionError?: boolean;
  readOnly?: boolean;
  taskPhase?: TaskPhase | null;
  queuedMessagesCount?: number;
  contextWindow?: {
    usedTokens: number;
    maxTokens: number;
  } | null;
}

type PromptInputStoryHarnessProps = ComponentProps<typeof PromptInput> & {
  sandbox?: PromptInputSandboxState;
};

const createMockSandboxClient = (): SandboxClient =>
  ({
    commands: {
      touchKeepalive: {
        mutate: async () => undefined,
      },
      cancelTask: {
        mutate: async () => undefined,
      },
      sendPrompt: {
        mutate: async () => undefined,
      },
      steerQueuedMessage: {
        mutate: async () => undefined,
      },
    },
  }) as unknown as SandboxClient;

function PromptInputStoryHarness({
  sandbox,
  ...props
}: PromptInputStoryHarnessProps) {
  const connected = sandbox?.connected ?? true;
  const connectionError = sandbox?.connectionError ?? false;
  const taskPhase = sandbox?.taskPhase ?? 'idle';
  const readOnly = sandbox?.readOnly ?? false;
  const queuedMessagesCount = sandbox?.queuedMessagesCount ?? 0;
  const contextWindow = sandbox?.contextWindow ?? null;

  const store = useMemo(() => {
    const nextStore = createSandboxStore({
      userId: 'storybook-user',
      userName: 'Storybook User',
      userEmail: 'storybook@example.com',
      userImageUrl: null,
    });

    nextStore
      .getState()
      ._setClient(connected ? createMockSandboxClient() : null);
    nextStore.getState()._setConnected(connected);
    nextStore.getState()._setConnectionError(connectionError);
    nextStore.getState()._setReadOnly(readOnly);
    nextStore.getState()._setTaskStatus(
      taskPhase
        ? {
            phase: taskPhase,
            taskStateEvent: null,
            sessionId: 'session-storybook',
            isConnected: connected,
            sleepRemainingMs: null,
            lastErrorMessage: undefined,
          }
        : null,
    );

    nextStore.setState({
      queuedMessages: Array.from(
        { length: queuedMessagesCount },
        (_, index) => ({
          id: `queued-${index + 1}`,
          text: `Queued prompt ${index + 1}`,
          timestamp: Date.now() + index,
        }),
      ),
      acpUsage: contextWindow
        ? {
            ...contextWindow,
            updatedAt: Date.now(),
          }
        : null,
    });

    return nextStore;
  }, [
    connected,
    connectionError,
    contextWindow,
    queuedMessagesCount,
    readOnly,
    taskPhase,
  ]);

  return (
    <SandboxStoreContext.Provider value={store}>
      <PromptInput {...props} />
    </SandboxStoreContext.Provider>
  );
}

const meta: Meta<typeof PromptInputStoryHarness> = {
  title: 'Surfaces/Task Workspace/Prompt Input/PromptInput',
  component: PromptInputStoryHarness,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <TRPCReactProvider>
        <div className="bg-background p-6 text-foreground">
          <Story />
        </div>
      </TRPCReactProvider>
    ),
  ],
  args: {
    onFileSearchOpen: () => undefined,
    onCommandSearchOpen: () => undefined,
    scrollToBottom: () => undefined,
    showTaskToolsMenu: false,
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const IdleReady: Story = {
  args: {
    initialPrompt: 'Drafting a plan for the release checklist.',
    sandbox: {
      connected: true,
      taskPhase: 'idle',
    },
  },
};

export const RunningWithStopControl: Story = {
  args: {
    initialPrompt: '',
    sandbox: {
      connected: true,
      taskPhase: 'running',
      queuedMessagesCount: 1,
    },
  },
};

export const Connecting: Story = {
  args: {
    initialPrompt: '',
    sandbox: {
      connected: false,
      connectionError: false,
      taskPhase: null,
    },
  },
};

export const WithContextUsage: Story = {
  args: {
    initialPrompt: 'Summarize the next steps from the latest changes.',
    sandbox: {
      connected: true,
      taskPhase: 'waiting_for_prompt',
      contextWindow: {
        usedTokens: 87_450,
        maxTokens: 128_000,
      },
    },
  },
};
