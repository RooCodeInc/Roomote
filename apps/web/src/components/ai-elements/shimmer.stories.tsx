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
    direction: {
      control: 'select',
      options: ['lr', 'rl', 'tb', 'bt'],
      description: 'Direction of the shimmer animation',
    },
    duration: {
      control: { type: 'number', min: 0.1, max: 10, step: 0.1 },
      description: 'Duration of one animation cycle in seconds',
    },
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
    duration: 2,
  },
};

export const RightToLeft: Story = {
  name: 'Right to Left',
  args: {
    children: 'Loading data...',
    direction: 'rl',
  },
};

export const TopToBottom: Story = {
  name: 'Top to Bottom',
  args: {
    children: 'Processing...',
    direction: 'tb',
  },
};

export const BottomToTop: Story = {
  name: 'Bottom to Top',
  args: {
    children: 'Analyzing...',
    direction: 'bt',
  },
};

export const FastDuration: Story = {
  name: 'Fast (0.5s)',
  args: {
    children: 'Almost there...',
    duration: 0.5,
  },
};

export const SlowDuration: Story = {
  name: 'Slow (4s)',
  args: {
    children: 'Taking my time...',
    duration: 4,
  },
};

export const AllDirections: Story = {
  render: () => (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-center gap-4">
        <span className="w-24 text-muted-foreground">Left → Right:</span>
        <Shimmer direction="lr">Thinking...</Shimmer>
      </div>
      <div className="flex items-center gap-4">
        <span className="w-24 text-muted-foreground">Right → Left:</span>
        <Shimmer direction="rl">Thinking...</Shimmer>
      </div>
      <div className="flex items-center gap-4">
        <span className="w-24 text-muted-foreground">Top → Bottom:</span>
        <Shimmer direction="tb">Thinking...</Shimmer>
      </div>
      <div className="flex items-center gap-4">
        <span className="w-24 text-muted-foreground">Bottom → Top:</span>
        <Shimmer direction="bt">Thinking...</Shimmer>
      </div>
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
