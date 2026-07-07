import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { House, Rows4 } from '@/components/system';

import { SideNavItem } from './SideNavItem';

const meta: Meta<typeof SideNavItem> = {
  title: 'Patterns/Layout/SideNav/SideNavItem',
  component: SideNavItem,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="flex flex-col items-center gap-2 bg-zinc-100 dark:bg-zinc-800 p-4 rounded-lg">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    icon: {
      control: false,
      description: 'Lucide icon component',
    },
    href: {
      control: 'text',
      description: 'Navigation link target',
    },
    tooltip: {
      control: 'text',
      description: 'Tooltip title text',
    },
    description: {
      control: 'text',
      description: 'Tooltip description text',
    },
    active: {
      control: 'boolean',
      description: 'Whether the nav item is currently active',
    },
    expanded: {
      control: 'boolean',
      description: 'Whether the sidebar is expanded',
    },
    onClick: {
      control: false,
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: House,
    href: '/',
    tooltip: 'Home',
    description: 'Start here',
    active: false,
    expanded: false,
  },
};

export const Active: Story = {
  args: {
    icon: House,
    href: '/',
    tooltip: 'Home',
    description: 'Start here',
    active: true,
    expanded: false,
  },
};

export const Expanded: Story = {
  args: {
    icon: House,
    href: '/',
    tooltip: 'Home',
    description: 'Start here',
    active: true,
    expanded: true,
  },
};

export const Action: Story = {
  args: {
    icon: Rows4,
    tooltip: 'Search (⌘K)',
    label: 'Search',
    description: 'Search and navigate',
    expanded: true,
    onClick: () => undefined,
  },
};

export const AllItems: Story = {
  render: () => (
    <div className="flex w-[280px] flex-col gap-1">
      <SideNavItem
        icon={House}
        href="/"
        tooltip="Home"
        description="Start here"
        active={true}
        expanded={true}
      />
      <SideNavItem
        icon={Rows4}
        href="/tasks"
        tooltip="History"
        description="View all tasks"
        active={false}
        expanded={true}
      />
    </div>
  ),
};
