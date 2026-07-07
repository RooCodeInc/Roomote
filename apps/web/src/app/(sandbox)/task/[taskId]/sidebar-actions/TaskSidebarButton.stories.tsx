import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import {
  Eye,
  Code2,
  FileBox,
  Camera,
  RotateCcw,
  Info,
  Share2,
} from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

const meta: Meta<typeof SideNavItem> = {
  title: 'Surfaces/Task Workspace/Sidebar/Actions/SideNavItem',
  component: SideNavItem,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    highlight: {
      control: 'boolean',
      description: 'Shows an animated ping indicator dot',
    },
    tooltip: {
      control: 'text',
      description: 'Tooltip text shown on hover',
    },
    label: {
      control: 'text',
      description: 'Accessibility label for icon-only usage',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the button is disabled',
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    side: 'right',
    label: 'Preview',
    children: <Eye className="size-4" />,
  },
};

export const WithTooltip: Story = {
  args: {
    side: 'right',
    label: 'Preview',
    tooltip: 'Preview',
    children: <Eye className="size-4" />,
  },
};

export const Highlighted: Story = {
  args: {
    side: 'right',
    label: 'Artifacts',
    tooltip: 'Artifacts (3 new)',
    highlight: true,
    children: <FileBox className="size-4" />,
  },
};

export const Disabled: Story = {
  args: {
    side: 'right',
    label: 'Snapshot',
    tooltip: 'Snapshot',
    disabled: true,
    children: <Camera className="size-4" />,
  },
};

export const SidebarColumn: Story = {
  render: () => (
    <div className="flex flex-col gap-2 border-l p-2">
      <SideNavItem side="right" label="Preview" tooltip="Preview">
        <Eye className="size-4" />
      </SideNavItem>
      <SideNavItem side="right" label="Editor" tooltip="Editor">
        <Code2 className="size-4" />
      </SideNavItem>
      <SideNavItem side="right" label="Artifacts" tooltip="Artifacts" highlight>
        <FileBox className="size-4" />
      </SideNavItem>
      <SideNavItem side="right" label="Snapshot" tooltip="Snapshot">
        <Camera className="size-4" />
      </SideNavItem>
      <SideNavItem side="right" label="Restore" tooltip="Restore">
        <RotateCcw className="size-4" />
      </SideNavItem>
      <div className="grow min-h-8" />
      <SideNavItem side="right" label="Task info" tooltip="Task info">
        <Info className="size-4" />
      </SideNavItem>
      <SideNavItem side="right" label="Share" tooltip="Share">
        <Share2 className="size-4" />
      </SideNavItem>
    </div>
  ),
};
