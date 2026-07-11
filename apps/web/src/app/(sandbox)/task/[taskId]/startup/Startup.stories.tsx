'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { RunStatus } from '@roomote/types';
import type { SandboxLogEntry } from '@roomote/types';

import { StartupSequence, type StartupStep } from './StartupMessage';

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta = {
  title: 'Surfaces/Task Workspace/Lifecycle/Startup',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="h-[600px] w-full max-w-2xl border rounded-lg overflow-hidden bg-background">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

const mockStep = (status: RunStatus, completed: boolean): StartupStep => ({
  status,
  completed,
});

const mockSandboxLogs: SandboxLogEntry[] = [
  {
    stream: 'stdout',
    data: '$ preparing workspace…',
    timestamp: 1700000000000,
  },
  {
    stream: 'stdout',
    data: '$ this is a very long message to see how it goes all the way to the right…',
    timestamp: 1700000000500,
  },
  {
    stream: 'stdout',
    data: 'Cloning repository roomote/example-cloud…',
    timestamp: 1700000001000,
  },
  {
    stream: 'stdout',
    data: "Cloning into '/workspace'…",
    timestamp: 1700000002000,
  },
  {
    stream: 'stderr',
    data: 'warning: redirecting to https://github.com/roomote/example-cloud.git/',
    timestamp: 1700000003000,
  },
  {
    stream: 'stdout',
    data: 'Receiving objects: 100% (1842/1842), 4.21 MiB | 12.00 MiB/s, done.',
    timestamp: 1700000004000,
  },
  {
    stream: 'stdout',
    data: 'Resolving deltas: 100% (1203/1203), done.',
    timestamp: 1700000005000,
  },
  { stream: 'stdout', data: '$ pnpm install', timestamp: 1700000006000 },
  {
    stream: 'stdout',
    data: 'Lockfile is up to date, resolution step is skipped',
    timestamp: 1700000007000,
  },
  { stream: 'stdout', data: 'Packages: +842', timestamp: 1700000008000 },
  {
    stream: 'stdout',
    data: 'Progress: resolved 842, reused 842, downloaded 0, added 842, done',
    timestamp: 1700000009000,
  },
  {
    stream: 'stdout',
    data: '$ starting live preview…',
    timestamp: 1700000010000,
  },
  {
    stream: 'stdout',
    data: '$ extra line…',
    timestamp: 1700000010005,
  },
  {
    stream: 'stdout',
    data: 'Preview proxy listening on 0.0.0.0:4200',
    timestamp: 1700000011000,
  },
];

// ---------------------------------------------------------------------------
// Individual StartupMessage stories
// ---------------------------------------------------------------------------

/** A single pending (queueing) step, actively animating. */
export const StepPending: Story = {
  name: 'Step – Pending (active)',
  render: () => (
    <StartupSequence steps={[mockStep(RunStatus.Pending, false)]} />
  ),
};

/** A single dequeued (booting) step. */
export const StepDequeued: Story = {
  name: 'Step – Dequeued',
  render: () => (
    <StartupSequence steps={[mockStep(RunStatus.Dequeued, false)]} />
  ),
};

/** A completed step (no shimmer animation). */
export const StepCompletedProcessing: Story = {
  name: 'Step – Processing (completed)',
  render: () => (
    <StartupSequence steps={[mockStep(RunStatus.Processing, true)]} />
  ),
};

/** All individual statuses displayed together, each completed except the last. */
export const AllStepStatuses: Story = {
  name: 'All step statuses',
  render: () => {
    const statuses = [
      RunStatus.Pending,
      RunStatus.Dequeued,
      RunStatus.Processing,
      RunStatus.Preparing,
      RunStatus.Spawning,
      RunStatus.Connecting,
    ] as const;

    return (
      <StartupSequence
        steps={statuses.map((status, i) =>
          mockStep(status, i < statuses.length - 1),
        )}
      />
    );
  },
};

/** All steps shown as not-yet-completed so each status icon is visible (no checkmarks). */
export const AllStepIcons: Story = {
  name: 'All step icons (none completed)',
  render: () => {
    const statuses = [
      RunStatus.Pending,
      RunStatus.Dequeued,
      RunStatus.Processing,
      RunStatus.Preparing,
      RunStatus.Spawning,
      RunStatus.Connecting,
    ] as const;

    return (
      <StartupSequence
        steps={statuses.map((status) => mockStep(status, false))}
      />
    );
  },
};

/** All statuses with the fully generic startup copy. */
export const AllStepStatusesGeneric: Story = {
  name: 'All step statuses (generic copy)',
  render: () => {
    const statuses = [
      RunStatus.Pending,
      RunStatus.Dequeued,
      RunStatus.Processing,
      RunStatus.Preparing,
      RunStatus.Spawning,
      RunStatus.Connecting,
    ] as const;

    return (
      <StartupSequence
        steps={statuses.map((status, i) =>
          mockStep(status, i < statuses.length - 1),
        )}
      />
    );
  },
};

/** Canceled task state. */
export const Canceled: Story = {
  render: () => (
    <StartupSequence
      steps={[
        mockStep(RunStatus.Pending, true),
        mockStep(RunStatus.Processing, true),
        mockStep(RunStatus.Canceled, true),
      ]}
    />
  ),
};

// ---------------------------------------------------------------------------
// Composite / full flow stories
// ---------------------------------------------------------------------------

/** Full boot sequence in progress — most steps completed, Connecting is active. */
export const FullBootInProgress: Story = {
  name: 'Full boot – In progress',
  render: () => (
    <StartupSequence
      steps={[
        mockStep(RunStatus.Pending, true),
        mockStep(RunStatus.Dequeued, true),
        mockStep(RunStatus.Processing, true),
        mockStep(RunStatus.Preparing, true),
        mockStep(RunStatus.Spawning, true),
        mockStep(RunStatus.Connecting, false),
      ]}
    />
  ),
};

/** Full boot sequence completed and running. */
export const FullBootRunning: Story = {
  name: 'Full boot – Running',
  render: () => (
    <StartupSequence
      steps={[
        mockStep(RunStatus.Pending, true),
        mockStep(RunStatus.Dequeued, true),
        mockStep(RunStatus.Processing, true),
        mockStep(RunStatus.Preparing, true),
        mockStep(RunStatus.Spawning, true),
        mockStep(RunStatus.Connecting, true),
      ]}
    />
  ),
};

/** Full boot with sandbox logs panel visible. */
export const WithSandboxLogs: Story = {
  name: 'With sandbox logs',
  render: () => (
    <StartupSequence
      steps={[
        mockStep(RunStatus.Pending, true),
        mockStep(RunStatus.Dequeued, true),
        mockStep(RunStatus.Processing, true),
        mockStep(RunStatus.Preparing, true),
        mockStep(RunStatus.Spawning, false),
      ]}
      logs={mockSandboxLogs}
    />
  ),
};

/** Sandbox logs showing a connection error. */
export const WithSandboxLogsError: Story = {
  name: 'With sandbox logs – Error',
  render: () => (
    <StartupSequence
      steps={[
        mockStep(RunStatus.Pending, true),
        mockStep(RunStatus.Dequeued, true),
        mockStep(RunStatus.Spawning, false),
      ]}
      logs={mockSandboxLogs.slice(0, 5)}
      logsConnected={false}
      logsError="WebSocket connection lost"
    />
  ),
};

/** Failed boot with logs and error message. */
export const FailedWithLogs: Story = {
  name: 'Failed boot with logs',
  render: () => (
    <StartupSequence
      steps={[
        mockStep(RunStatus.Pending, true),
        mockStep(RunStatus.Dequeued, true),
        mockStep(RunStatus.Processing, true),
        mockStep(RunStatus.Preparing, true),
        mockStep(RunStatus.Spawning, true),
        mockStep(RunStatus.Failed, true),
      ]}
      error="Sandbox container failed to start: timeout after 60s"
      logs={mockSandboxLogs}
      logsConnected={false}
    />
  ),
};

/** Failed boot without a specific error message — shows fallback copy. */
export const FailedWithoutError: Story = {
  name: 'Failed boot without error message',
  render: () => (
    <StartupSequence
      steps={[
        mockStep(RunStatus.Pending, true),
        mockStep(RunStatus.Dequeued, true),
        mockStep(RunStatus.Failed, true),
      ]}
      logs={mockSandboxLogs.slice(0, 3)}
      logsConnected={false}
    />
  ),
};

/** Minimal: single pending step, just started. */
export const JustStarted: Story = {
  name: 'Just started',
  render: () => (
    <StartupSequence steps={[mockStep(RunStatus.Pending, false)]} />
  ),
};
