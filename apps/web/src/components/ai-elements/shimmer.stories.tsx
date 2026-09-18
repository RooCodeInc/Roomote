'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Shimmer } from './shimmer';

const meta: Meta<typeof Shimmer> = {
  title: 'Patterns/AI Elements/Feedback/Shimmer',
  component: Shimmer,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    spread: {
      control: { type: 'number', min: 0.5, max: 10, step: 0.5 },
      description: 'Spread multiplier for the shimmer gradient',
    },
    as: {
      control: 'select',
      options: ['div', 'span', 'p', 'h1', 'h2'],
      description: 'HTML element to render as',
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Thinking...',
  },
};

export const StatusMessages: Story = {
  render: () => (
    <div className="flex flex-col gap-4 text-sm">
      <Shimmer>Thinking...</Shimmer>
      <Shimmer>Waking up</Shimmer>
      <Shimmer>Preparing your environment</Shimmer>
      <Shimmer as="span" spread={1}>
        2 tasks running
      </Shimmer>
    </div>
  ),
};

export const AsHeading: Story = {
  name: 'As Heading Element',
  args: {
    children: 'Thinking deeply...',
    as: 'h2',
    className: 'text-2xl font-bold',
  },
};
