'use client';

import type { ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { RunStatus } from '@roomote/types';

import type { Task } from '@/lib/server';
import { TASK_BOARD_COLUMNS, type TaskBoardColumn } from '@/types';
import { TRPCReactProvider } from '@/trpc/client';

import { TaskBoard } from './TaskBoard';
import { getTaskBoardColumn } from './task-board';

const PEOPLE = {
  ada: {
    id: 'ada',
    name: 'Ada Lovelace',
    email: 'ada@roomote.test',
    imageUrl: '',
  },
  grace: {
    id: 'grace',
    name: 'Grace Hopper',
    email: 'grace@roomote.test',
    imageUrl: '',
  },
  alan: {
    id: 'alan',
    name: 'Alan Turing',
    email: 'alan@roomote.test',
    imageUrl: '',
  },
};

function createTask(
  id: string,
  title: string,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    initiatorKind: 'user',
    initiatorUserId: PEOPLE.ada.id,
    initiatorAutomation: null,
    title,
    mode: 'autonomous',
    state: 'active',
    workflow: 'standard',
    surface: 'discord',
    timestamp: new Date('2026-08-20T14:00:00Z').getTime() / 1000,
    activityAt: new Date('2026-08-20T15:10:00Z').getTime() / 1000,
    repositoryName: 'RooCodeInc/Roomote',
    attributionLabel: PEOPLE.ada.name,
    attributionKind: 'user',
    user: PEOPLE.ada,
    participants: [PEOPLE.grace, PEOPLE.alan],
    taskRun: {
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: { repo: 'RooCodeInc/Roomote' },
      prRepo: null,
      prNumber: null,
    },
    ...overrides,
  } as Task;
}

const tasks: Task[] = [
  createTask('active-1', 'Build a shared task workspace', {
    surface: 'discord',
    taskRun: {
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: { repo: 'RooCodeInc/Roomote' },
      prRepo: 'RooCodeInc/Roomote',
      prNumber: 1501,
    } as Task['taskRun'],
  }),
  createTask('active-2', 'Investigate model latency across providers', {
    repositoryName: null,
    surface: 'slack',
    participants: [PEOPLE.grace],
    taskRun: {
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {},
      prRepo: null,
      prNumber: null,
    } as Task['taskRun'],
  }),
  createTask('input-1', 'Choose the release-note screenshots', {
    surface: 'web',
    taskRun: {
      status: RunStatus.Running,
      taskPhase: 'waiting_for_user_input',
      payload: { repo: 'RooCodeInc/Roomote' },
      prRepo: null,
      prNumber: null,
    } as Task['taskRun'],
  }),
  createTask('blocked-1', 'Publish the next worker image', {
    state: 'failed',
    goalStatus: 'blocked',
    goalBlockedReason: 'Container registry credentials need to be renewed.',
    surface: 'github',
  }),
  createTask('blocked-2', 'Review authentication boundary changes', {
    state: 'failed',
    workflow: 'pr_review',
    surface: 'github',
  }),
  ...Array.from({ length: 8 }, (_, index) =>
    createTask(
      `done-${index + 1}`,
      [
        'Refresh task titles across the app',
        'Document the Discord setup flow',
        'Tighten sandbox cleanup reporting',
        'Add Telegram reply footers',
        'Improve environment health checks',
        'Update the task model selector',
        'Simplify notification routing',
        'Polish the onboarding checklist',
      ][index] ?? `Completed task ${index + 1}`,
      {
        state: 'completed',
        surface: index % 2 === 0 ? 'discord' : 'web',
        activityAt:
          new Date('2026-08-20T14:30:00Z').getTime() / 1000 - index * 600,
        taskRun: {
          status: RunStatus.Completed,
          taskPhase: null,
          payload: { repo: 'RooCodeInc/Roomote' },
          prRepo: index < 2 ? 'RooCodeInc/Roomote' : null,
          prNumber: index < 2 ? 1497 + index : null,
        } as Task['taskRun'],
      },
    ),
  ),
];

const tasksByColumn = Object.fromEntries(
  TASK_BOARD_COLUMNS.map((column) => [
    column,
    tasks.filter((task) => getTaskBoardColumn(task) === column),
  ]),
) as Record<TaskBoardColumn, Task[]>;
const columns = Object.fromEntries(
  TASK_BOARD_COLUMNS.map((column) => [
    column,
    {
      tasks: tasksByColumn[column].slice(0, 6),
      hasNextPage: tasksByColumn[column].length > 6,
      isFetchingNextPage: false,
      onShowMore: () => {},
    },
  ]),
) as ComponentProps<typeof TaskBoard>['columns'];

const meta: Meta<typeof TaskBoard> = {
  title: 'Tasks/Shared workspace board',
  component: TaskBoard,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <TRPCReactProvider>
        <div className="min-h-screen bg-background p-4">
          <Story />
        </div>
      </TRPCReactProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const SharedWorkspace: Story = {
  args: { columns },
};

export const Mobile: Story = {
  args: { columns },
  parameters: {
    viewport: {
      defaultViewport: 'mobile2',
    },
  },
};
