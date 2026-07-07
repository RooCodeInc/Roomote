'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { AcpCommandOutputMessage } from './AcpCommandOutputMessage';
import type { AcpToolResultUiMessage } from './types';

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta<typeof AcpCommandOutputMessage> = {
  title: 'Surfaces/Task Workspace/ACP/CommandOutputMessage',
  component: AcpCommandOutputMessage,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl border rounded-lg overflow-hidden bg-background p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AcpCommandOutputMessage>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toolResultMsg = (
  overrides: { command?: string; text?: string; exitCode?: number } = {},
): AcpToolResultUiMessage =>
  ({
    id: 'story-msg',
    ts: 0,
    role: 'assistant',
    partial: false,
    sessionId: null,
    updateType: 'tool_result',
    kind: 'tool_result',
    text: overrides.text ?? '',
    data: {
      toolCallId: null,
      kind: 'execute',
      title: null,
      isExecute: true,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: overrides.command ?? null,
      exitCode: overrides.exitCode ?? null,
      output: overrides.text ?? '',
      status: null,
    },
  }) as unknown as AcpToolResultUiMessage;

const SHORT_COMMAND = 'ls -la';
const MEDIUM_COMMAND =
  'npm run build -- --filter @roomote/web --no-cache --verbose';
const LONG_COMMAND =
  'DOCKER_BUILDKIT=1 docker build --platform linux/amd64 --build-arg NODE_ENV=production --build-arg NEXT_PUBLIC_API_URL=https://api.example.com --build-arg NEXT_PUBLIC_WS_URL=wss://ws.example.com -t my-app:latest -f ./apps/web/Dockerfile .';

const SHORT_OUTPUT = 'total 42\ndrwxr-xr-x  12 user  staff  384 Mar 10 14:00 .';

const MEDIUM_OUTPUT = `> @roomote/web@0.1.0 build
> next build

   Creating an optimized production build ...
   Compiled successfully
   Linting and checking validity of types ...
   Collecting page data ...
   Generating static pages (0/12) ...
   Generating static pages (3/12) ...
   Generating static pages (6/12) ...
   Generating static pages (9/12) ...
   Generating static pages (12/12)
   Finalizing page optimization ...

Route (app)                              Size     First Load JS
\u250C \u25CB /                                    5.23 kB        89.2 kB
\u251C \u25CB /dashboard                           12.4 kB        96.4 kB
\u251C \u25CB /settings                            8.91 kB        92.9 kB
\u2514 \u25CB /tasks                               15.2 kB        99.2 kB

\u25CB  (Static)  prerendered as static content

Build completed in 42.3s`;

const LONG_OUTPUT = `Step 1/24 : FROM node:22-slim AS base
 ---> a1b2c3d4e5f6
Step 2/24 : RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl
 ---> Using cache
 ---> b2c3d4e5f6a7
Step 3/24 : WORKDIR /app
 ---> Using cache
 ---> c3d4e5f6a7b8
Step 4/24 : COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
 ---> d4e5f6a7b8c9
Step 5/24 : COPY packages/db/package.json packages/db/
 ---> e5f6a7b8c9d0
Step 6/24 : COPY packages/auth/package.json packages/auth/
 ---> f6a7b8c9d0e1
Step 7/24 : COPY packages/types/package.json packages/types/
 ---> a7b8c9d0e1f2
Step 8/24 : RUN corepack enable && corepack prepare pnpm@10 --activate
 ---> Using cache
 ---> b8c9d0e1f2a3
Step 9/24 : RUN pnpm install --frozen-lockfile
 ---> Running in container abc123
Scope: all 14 workspace projects
Packages: +1842
+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 1842, reused 1840, downloaded 2, added 1842, done
 ---> c9d0e1f2a3b4
Step 10/24 : COPY . .
 ---> d0e1f2a3b4c5
Step 11/24 : RUN pnpm --filter @roomote/web build
 ---> Running in container def456

> @roomote/web@0.1.0 build
> next build

   Creating an optimized production build ...
   Compiled successfully
   Linting and checking validity of types ...
   Collecting page data ...
   Generating static pages (0/24) ...
   Generating static pages (12/24) ...
   Generating static pages (24/24)
   Finalizing page optimization ...

Route (app)                              Size     First Load JS
\u250C \u25CB /                                    5.23 kB        89.2 kB
\u251C \u25CB /dashboard                           12.4 kB        96.4 kB
\u251C \u25CB /settings                            8.91 kB        92.9 kB
\u251C \u25CB /tasks                               15.2 kB        99.2 kB
\u251C \u25CB /tasks/[id]                          18.7 kB       102.7 kB
\u251C \u25CB /agents                              9.45 kB        93.4 kB
\u2514 \u25CB /api/trpc/[trpc]                     0 B                0 B

\u25CB  (Static)  prerendered as static content
\u0192  (Dynamic) server-rendered on demand

 ---> e1f2a3b4c5d6
Step 12/24 : FROM node:22-slim AS runner
 ---> a1b2c3d4e5f6
Step 13/24 : WORKDIR /app
 ---> Using cache
 ---> f2a3b4c5d6e7
Step 14/24 : COPY --from=base /app/apps/web/.next/standalone ./
 ---> a3b4c5d6e7f8
Step 15/24 : COPY --from=base /app/apps/web/.next/static ./apps/web/.next/static
 ---> b4c5d6e7f8a9
Step 16/24 : EXPOSE 3000
 ---> Using cache
 ---> c5d6e7f8a9b0
Successfully built c5d6e7f8a9b0
Successfully tagged my-app:latest`;

// ---------------------------------------------------------------------------
// Short command variants
// ---------------------------------------------------------------------------

export const ShortCommandShortOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: SHORT_COMMAND,
      text: SHORT_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000000000,
    status: 'completed',
  },
};

export const ShortCommandMediumOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: SHORT_COMMAND,
      text: MEDIUM_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000001000,
    status: 'completed',
  },
};

export const ShortCommandLongOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: SHORT_COMMAND,
      text: LONG_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000002000,
    status: 'completed',
  },
};

// ---------------------------------------------------------------------------
// Medium command variants
// ---------------------------------------------------------------------------

export const MediumCommandShortOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: MEDIUM_COMMAND,
      text: SHORT_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000003000,
    status: 'completed',
  },
};

export const MediumCommandMediumOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: MEDIUM_COMMAND,
      text: MEDIUM_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000004000,
    status: 'completed',
  },
};

export const MediumCommandLongOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: MEDIUM_COMMAND,
      text: LONG_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000005000,
    status: 'completed',
  },
};

// ---------------------------------------------------------------------------
// Long command variants
// ---------------------------------------------------------------------------

export const LongCommandShortOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: LONG_COMMAND,
      text: SHORT_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000006000,
    status: 'completed',
  },
};

export const LongCommandMediumOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: LONG_COMMAND,
      text: MEDIUM_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000007000,
    status: 'completed',
  },
};

export const LongCommandLongOutput: Story = {
  args: {
    msg: toolResultMsg({
      command: LONG_COMMAND,
      text: LONG_OUTPUT,
      exitCode: 0,
    }),
    ts: 1700000008000,
    status: 'completed',
  },
};

// ---------------------------------------------------------------------------
// Spinner (in_progress) states
// ---------------------------------------------------------------------------

export const SpinnerShortCommand: Story = {
  args: {
    msg: toolResultMsg({ command: SHORT_COMMAND, text: '' }),
    ts: 1700000009000,
    status: 'in_progress',
  },
};

export const SpinnerMediumCommand: Story = {
  args: {
    msg: toolResultMsg({ command: MEDIUM_COMMAND, text: '' }),
    ts: 1700000010000,
    status: 'in_progress',
  },
};

export const SpinnerLongCommand: Story = {
  args: {
    msg: toolResultMsg({ command: LONG_COMMAND, text: '' }),
    ts: 1700000011000,
    status: 'in_progress',
  },
};

export const SpinnerWithPartialOutput: Story = {
  args: {
    msg: toolResultMsg({ command: MEDIUM_COMMAND, text: SHORT_OUTPUT }),
    ts: 1700000012000,
    status: 'in_progress',
  },
};

// ---------------------------------------------------------------------------
// Status variants
// ---------------------------------------------------------------------------

export const Failed: Story = {
  args: {
    msg: toolResultMsg({
      command: MEDIUM_COMMAND,
      text: 'ERR! code ELIFECYCLE\nERR! errno 1\nERR! @roomote/web@0.1.0 build: `next build`\nERR! Exit status 1',
      exitCode: 1,
    }),
    ts: 1700000013000,
    status: 'failed',
  },
};

export const FailedWithExitCode: Story = {
  args: {
    msg: toolResultMsg({
      command: SHORT_COMMAND,
      text: 'bash: command not found: unknown-cmd',
      exitCode: 127,
    }),
    ts: 1700000014000,
    status: 'failed',
  },
};

export const NoCommand: Story = {
  args: {
    msg: toolResultMsg({ text: SHORT_OUTPUT, exitCode: 0 }),
    ts: 1700000015000,
    status: 'completed',
  },
};

export const EmptyOutput: Story = {
  args: {
    msg: toolResultMsg({ command: SHORT_COMMAND, text: '', exitCode: 0 }),
    ts: 1700000016000,
    status: 'completed',
  },
};

export const NullStatus: Story = {
  args: {
    msg: toolResultMsg({ command: SHORT_COMMAND, text: '' }),
    ts: 1700000017000,
    status: null,
  },
};
