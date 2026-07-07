'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Terminal } from './terminal';

const meta: Meta<typeof Terminal> = {
  title: 'Patterns/AI Elements/Conversation/Terminal',
  component: Terminal,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    output: {
      control: 'text',
      description: 'Terminal output text',
    },
    isStreaming: {
      control: 'boolean',
      description: 'Whether the terminal is actively streaming output',
    },
    autoScroll: {
      control: 'boolean',
      description: 'Whether to auto-scroll to the bottom on new output',
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const StaticOutput: Story = {
  args: {
    output: `$ npm install
added 142 packages, and audited 143 packages in 3s

24 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities`,
  },
};

export const ANSIColors: Story = {
  args: {
    output: [
      '\x1b[32m✓\x1b[0m All tests passed',
      '\x1b[31m✗\x1b[0m 2 tests failed',
      '\x1b[33m⚠\x1b[0m 1 test skipped',
      '\x1b[36mℹ\x1b[0m Running test suite...',
      '',
      '\x1b[1m\x1b[4mTest Results:\x1b[0m',
      '  \x1b[32m✓\x1b[0m should render correctly',
      '  \x1b[32m✓\x1b[0m should handle click events',
      '  \x1b[31m✗\x1b[0m should validate input \x1b[2m(expected true, got false)\x1b[0m',
      '  \x1b[31m✗\x1b[0m should fetch data \x1b[2m(timeout after 5000ms)\x1b[0m',
      '  \x1b[33m○\x1b[0m should handle edge case \x1b[2m(skipped)\x1b[0m',
      '',
      '\x1b[1mSuites:\x1b[0m  \x1b[32m3 passed\x1b[0m, \x1b[31m1 failed\x1b[0m, 4 total',
      '\x1b[1mTests:\x1b[0m   \x1b[32m2 passed\x1b[0m, \x1b[31m2 failed\x1b[0m, \x1b[33m1 skipped\x1b[0m, 5 total',
    ].join('\n'),
  },
};

export const Streaming: Story = {
  args: {
    output: [
      '$ pnpm build',
      '',
      '> @roomote/web@0.1.0 build',
      '> next build',
      '',
      '  ▲ Next.js 16.0.0',
      '',
      '   Creating an optimized production build ...',
    ].join('\n'),
    isStreaming: true,
  },
};

export const WithClearButton: Story = {
  args: {
    output: [
      '$ echo "Hello, world!"',
      'Hello, world!',
      '$ date',
      'Mon Feb 10 18:00:00 UTC 2025',
    ].join('\n'),
    onClear: () => console.log('clear'),
  },
};

export const LongOutput: Story = {
  name: 'Long Output (scrollable)',
  args: {
    output: Array.from(
      { length: 60 },
      (_, i) =>
        `[${String(i + 1).padStart(3, '0')}] Processing file ${i + 1}/60... ${i < 58 ? '\x1b[32mdone\x1b[0m' : '\x1b[33min progress\x1b[0m'}`,
    ).join('\n'),
    isStreaming: true,
  },
};

export const Empty: Story = {
  name: 'Empty Terminal',
  args: {
    output: '',
  },
};

export const GitOutput: Story = {
  name: 'Git Operations',
  args: {
    output: [
      '$ git status',
      'On branch feature/dark-mode',
      "Your branch is up to date with 'origin/feature/dark-mode'.",
      '',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '',
      '\x1b[31m\tmodified:   src/components/Header.tsx\x1b[0m',
      '\x1b[31m\tmodified:   src/app/globals.css\x1b[0m',
      '',
      'Untracked files:',
      '  (use "git add <file>..." to include in what will be committed)',
      '',
      '\x1b[31m\tsrc/hooks/useTheme.ts\x1b[0m',
      '',
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ].join('\n'),
  },
};

export const StreamingWithClear: Story = {
  name: 'Streaming + Clear',
  args: {
    output: [
      '$ pnpm dev',
      '',
      '> @roomote/web@0.1.0 dev',
      '> next dev --turbopack',
      '',
      '  ▲ Next.js 16.0.0 (Turbopack)',
      '  - Local:        http://localhost:3000',
      '  - Network:      http://192.168.1.100:3000',
      '',
      ' ✓ Starting...',
      ' ✓ Ready in 1.2s',
    ].join('\n'),
    isStreaming: true,
    onClear: () => console.log('clear'),
  },
};
