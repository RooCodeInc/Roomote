import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { InfoTooltip } from './info-tooltip';

const meta: Meta<typeof InfoTooltip> = {
  title: 'Foundations/Primitives/InfoTooltip',
  component: InfoTooltip,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    content: {
      control: 'text',
      description: 'The content to display in the tooltip',
    },
    iconClassName: {
      control: 'text',
      description: 'Additional CSS classes for the info icon',
    },
    contentClassName: {
      control: 'text',
      description: 'Additional CSS classes for the tooltip content',
    },
  },
} satisfies Meta<typeof InfoTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default tooltip
export const Default: Story = {
  args: {
    content: 'This is helpful information about this feature.',
  },
};

// Short content
export const ShortContent: Story = {
  args: {
    content: 'Quick tip!',
  },
};

// Long content
export const LongContent: Story = {
  args: {
    content:
      'This is a longer piece of information that provides detailed context about a specific feature or functionality. It wraps nicely within the tooltip container.',
  },
};

// With custom icon styling
export const CustomIconStyle: Story = {
  args: {
    content: 'Tooltip content',
  },
  render: () => (
    <div className="flex items-center gap-8">
      <div className="flex items-center gap-2">
        <span>Default size</span>
        <InfoTooltip content="Default size info icon" />
      </div>
      <div className="flex items-center gap-2">
        <span>Larger icon</span>
        <InfoTooltip
          content="Larger info icon with custom class"
          iconClassName="!size-4"
        />
      </div>
      <div className="flex items-center gap-2">
        <span>Primary color</span>
        <InfoTooltip
          content="Primary colored info icon"
          iconClassName="!text-primary"
        />
      </div>
      <div className="flex items-center gap-2">
        <span>Warning color</span>
        <InfoTooltip
          content="Warning colored info icon"
          iconClassName="!text-amber-500"
        />
      </div>
    </div>
  ),
};

// With custom content styling
export const CustomContentStyle: Story = {
  args: {
    content: 'Tooltip content',
  },
  render: () => (
    <div className="flex items-center gap-8">
      <div className="flex items-center gap-2">
        <span>Default style</span>
        <InfoTooltip content="Default tooltip content style" />
      </div>
      <div className="flex items-center gap-2">
        <span>Smaller text</span>
        <InfoTooltip
          content="Smaller text in tooltip"
          contentClassName="text-xs"
        />
      </div>
      <div className="flex items-center gap-2">
        <span>Bold text</span>
        <InfoTooltip
          content="Bold text in tooltip"
          contentClassName="font-bold"
        />
      </div>
    </div>
  ),
};

// In context examples
export const InContext: Story = {
  args: {
    content: 'Tooltip content',
  },
  render: () => (
    <div className="space-y-4 w-full max-w-md">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">API Key</label>
        <InfoTooltip content="Your API key is used to authenticate requests to our service. Keep it secure and never share it publicly." />
      </div>

      <div className="p-4 border rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-lg font-semibold">Advanced Settings</h3>
          <InfoTooltip content="These settings are for advanced users. Modifying them may affect system performance." />
        </div>
        <p className="text-sm text-muted-foreground">
          Configure advanced options for your application.
        </p>
      </div>

      <div className="flex items-center justify-between p-3 bg-muted rounded">
        <span className="text-sm">Enable notifications</span>
        <div className="flex items-center gap-2">
          <InfoTooltip content="When enabled, you'll receive email notifications for important events." />
          <input type="checkbox" className="rounded" />
        </div>
      </div>
    </div>
  ),
};

// Multiple tooltips
export const MultipleTooltips: Story = {
  args: {
    content: 'Tooltip content',
  },
  render: () => (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-1">
        <span>Feature A</span>
        <InfoTooltip content="Information about Feature A" />
      </div>
      <div className="flex items-center gap-1">
        <span>Feature B</span>
        <InfoTooltip content="Information about Feature B" />
      </div>
      <div className="flex items-center gap-1">
        <span>Feature C</span>
        <InfoTooltip content="Information about Feature C" />
      </div>
    </div>
  ),
};

// Touch device behavior
export const TouchDevice: Story = {
  args: {
    content: 'Tooltip content',
  },
  render: () => (
    <div className="text-center space-y-4">
      <p className="text-sm text-muted-foreground">
        On touch devices, tap the icon to open the tooltip
      </p>
      <div className="flex items-center justify-center gap-2">
        <span>Tap to see info</span>
        <InfoTooltip content="This tooltip opens on tap for touch devices and on hover for desktop." />
      </div>
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    content: 'Edit this tooltip content in the controls below',
    iconClassName: '',
    contentClassName: '',
  },
};
