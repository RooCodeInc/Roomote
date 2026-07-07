'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from './task';

const meta: Meta = {
  title: 'Patterns/AI Elements/Conversation/MultiTool',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl bg-background p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Task>
      <TaskTrigger title="Searching for relevant files" />
      <TaskContent>
        <TaskItem>Found 3 matching files in the workspace</TaskItem>
        <TaskItem>
          <TaskItemFile>src/components/Button.tsx</TaskItemFile>
        </TaskItem>
        <TaskItem>
          <TaskItemFile>src/components/Input.tsx</TaskItemFile>
        </TaskItem>
        <TaskItem>
          <TaskItemFile>src/components/Form.tsx</TaskItemFile>
        </TaskItem>
      </TaskContent>
    </Task>
  ),
};

export const ClosedByDefault: Story = {
  name: 'Closed by Default',
  render: () => (
    <Task defaultOpen={false}>
      <TaskTrigger title="Analyzed project structure" />
      <TaskContent>
        <TaskItem>Identified 12 source files</TaskItem>
        <TaskItem>Found 3 test files</TaskItem>
      </TaskContent>
    </Task>
  ),
};

export const WithFiles: Story = {
  name: 'With File Badges',
  render: () => (
    <Task>
      <TaskTrigger title="Reading configuration files" />
      <TaskContent>
        <TaskItem>
          <span className="flex items-center gap-2 flex-wrap">
            Checking <TaskItemFile>tsconfig.json</TaskItemFile> and{' '}
            <TaskItemFile>package.json</TaskItemFile>
          </span>
        </TaskItem>
        <TaskItem>
          <span className="flex items-center gap-2 flex-wrap">
            Updated <TaskItemFile>eslint.config.mjs</TaskItemFile>
          </span>
        </TaskItem>
      </TaskContent>
    </Task>
  ),
};

export const MultipleItems: Story = {
  name: 'Multiple Task Items',
  render: () => (
    <Task>
      <TaskTrigger title="Implementing feature: dark mode toggle" />
      <TaskContent>
        <TaskItem>Analyzed existing theme configuration</TaskItem>
        <TaskItem>
          <span className="flex items-center gap-2 flex-wrap">
            Created <TaskItemFile>src/hooks/useTheme.ts</TaskItemFile>
          </span>
        </TaskItem>
        <TaskItem>
          <span className="flex items-center gap-2 flex-wrap">
            Modified <TaskItemFile>src/components/Header.tsx</TaskItemFile>
          </span>
        </TaskItem>
        <TaskItem>Added CSS variables for dark mode colors</TaskItem>
        <TaskItem>
          <span className="flex items-center gap-2 flex-wrap">
            Updated <TaskItemFile>src/app/globals.css</TaskItemFile>
          </span>
        </TaskItem>
        <TaskItem>Tested toggle functionality across all pages</TaskItem>
      </TaskContent>
    </Task>
  ),
};

export const MultipleTasks: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Task>
        <TaskTrigger title="Step 1: Analyzing requirements" />
        <TaskContent>
          <TaskItem>Parsed user request</TaskItem>
          <TaskItem>Identified affected components</TaskItem>
        </TaskContent>
      </Task>
      <Task>
        <TaskTrigger title="Step 2: Implementing changes" />
        <TaskContent>
          <TaskItem>
            <span className="flex items-center gap-2 flex-wrap">
              Modified <TaskItemFile>src/index.ts</TaskItemFile>
            </span>
          </TaskItem>
        </TaskContent>
      </Task>
      <Task defaultOpen={false}>
        <TaskTrigger title="Step 3: Running tests" />
        <TaskContent>
          <TaskItem>All 42 tests passed</TaskItem>
        </TaskContent>
      </Task>
    </div>
  ),
};
