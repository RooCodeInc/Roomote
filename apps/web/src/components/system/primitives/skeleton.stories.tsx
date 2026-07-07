import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Skeleton } from './skeleton';

const meta = {
  title: 'Foundations/Primitives/Skeleton',
  component: Skeleton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    className: {
      control: 'text',
      description: 'Additional CSS classes to apply to the skeleton',
    },
  },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default skeleton
export const Default: Story = {
  args: {
    className: 'h-4 w-[250px]',
  },
};

// Text lines skeleton
export const TextLines: Story = {
  render: () => (
    <div className="space-y-2">
      <Skeleton className="h-4 w-[250px]" />
      <Skeleton className="h-4 w-50" />
      <Skeleton className="h-4 w-37.5" />
    </div>
  ),
};

// Paragraph skeleton
export const Paragraph: Story = {
  render: () => (
    <div className="space-y-2">
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-4 w-3/4 max-w-md" />
    </div>
  ),
};

// Card skeleton
export const Card: Story = {
  render: () => (
    <div className="flex flex-col space-y-3">
      <Skeleton className="h-[125px] w-[250px] rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-[250px]" />
        <Skeleton className="h-4 w-50" />
      </div>
    </div>
  ),
};

// Avatar skeleton
export const Avatar: Story = {
  render: () => (
    <div className="flex items-center space-x-4">
      <Skeleton className="h-12 w-12 rounded-full" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-50" />
        <Skeleton className="h-4 w-37.5" />
      </div>
    </div>
  ),
};

// Avatar sizes
export const AvatarSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Skeleton className="h-8 w-8 rounded-full" />
      <Skeleton className="h-10 w-10 rounded-full" />
      <Skeleton className="h-12 w-12 rounded-full" />
      <Skeleton className="h-16 w-16 rounded-full" />
      <Skeleton className="h-20 w-20 rounded-full" />
    </div>
  ),
};

// Image skeleton
export const Image: Story = {
  render: () => (
    <div className="space-y-4">
      <Skeleton className="h-[200px] w-[300px] rounded-lg" />
      <div className="flex gap-2">
        <Skeleton className="h-20 w-20 rounded-md" />
        <Skeleton className="h-20 w-20 rounded-md" />
        <Skeleton className="h-20 w-20 rounded-md" />
      </div>
    </div>
  ),
};

// Table skeleton
export const Table: Story = {
  render: () => (
    <div className="w-full max-w-2xl">
      <div className="space-y-3">
        {/* Header */}
        <div className="flex gap-4">
          <Skeleton className="h-8 w-[100px]" />
          <Skeleton className="h-8 w-37.5" />
          <Skeleton className="h-8 w-[100px]" />
          <Skeleton className="h-8 w-[80px]" />
        </div>
        {/* Rows */}
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flex gap-4">
            <Skeleton className="h-6 w-[100px]" />
            <Skeleton className="h-6 w-37.5" />
            <Skeleton className="h-6 w-[100px]" />
            <Skeleton className="h-6 w-[80px]" />
          </div>
        ))}
      </div>
    </div>
  ),
};

// Form skeleton
export const Form: Story = {
  render: () => (
    <div className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-4 w-[100px]" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-[100px]" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-[100px]" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="h-10 w-[100px]" />
    </div>
  ),
};

// List skeleton
export const List: Story = {
  render: () => (
    <div className="w-full max-w-md">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center space-x-4 mb-4">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  ),
};

// Dashboard widgets skeleton
export const DashboardWidgets: Story = {
  render: () => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-4xl">
      {/* Stats cards */}
      {[...Array(3)].map((_, i) => (
        <div key={i} className="p-4 border rounded-lg space-y-2">
          <Skeleton className="h-4 w-[100px]" />
          <Skeleton className="h-8 w-37.5" />
          <Skeleton className="h-3 w-[80px]" />
        </div>
      ))}
      {/* Chart */}
      <div className="col-span-1 md:col-span-3 p-4 border rounded-lg">
        <Skeleton className="h-4 w-37.5 mb-4" />
        <Skeleton className="h-[200px] w-full" />
      </div>
    </div>
  ),
};

// Media card skeleton
export const MediaCard: Story = {
  render: () => (
    <div className="w-[350px] border rounded-lg overflow-hidden">
      <Skeleton className="h-[200px] w-full" />
      <div className="p-4 space-y-3">
        <Skeleton className="h-6 w-3/4" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
      </div>
    </div>
  ),
};

// Profile skeleton
export const Profile: Story = {
  render: () => (
    <div className="w-full max-w-sm">
      <div className="flex flex-col items-center space-y-4">
        <Skeleton className="h-24 w-24 rounded-full" />
        <Skeleton className="h-6 w-37.5" />
        <Skeleton className="h-4 w-50" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-[80px] rounded-md" />
          <Skeleton className="h-8 w-[80px] rounded-md" />
        </div>
      </div>
    </div>
  ),
};

// Different shapes
export const Shapes: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Skeleton className="h-16 w-16" />
      <Skeleton className="h-16 w-16 rounded-md" />
      <Skeleton className="h-16 w-16 rounded-lg" />
      <Skeleton className="h-16 w-16 rounded-xl" />
      <Skeleton className="h-16 w-16 rounded-full" />
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    className: 'h-10 w-50',
  },
};
