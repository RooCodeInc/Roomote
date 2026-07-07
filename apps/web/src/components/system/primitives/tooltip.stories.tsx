import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from './tooltip';
import { Button } from './button';
import { Badge } from './badge';

const meta: Meta<typeof Tooltip> = {
  title: 'Foundations/Primitives/Tooltip',
  component: Tooltip,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="flex min-h-[200px] items-center justify-center">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    defaultOpen: {
      control: 'boolean',
      description: 'Whether the tooltip is open by default',
    },
    open: {
      control: 'boolean',
      description: 'Controlled open state',
    },
    delayDuration: {
      control: 'number',
      description: 'Delay in milliseconds before showing the tooltip',
    },
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default tooltip
export const Default: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Hover me</Button>
      </TooltipTrigger>
      <TooltipContent>This is a tooltip</TooltipContent>
    </Tooltip>
  ),
};

// Different positions
export const Positions: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-8">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" className="w-full">
            Top
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Tooltip on top</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" className="w-full">
            Bottom
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Tooltip on bottom</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" className="w-full">
            Left
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Tooltip on left</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" className="w-full">
            Right
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Tooltip on right</TooltipContent>
      </Tooltip>
    </div>
  ),
};

// Different trigger types
export const TriggerTypes: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button>Button Trigger</Button>
        </TooltipTrigger>
        <TooltipContent>Tooltip on a button</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block cursor-help underline decoration-dotted">
            Text Trigger
          </span>
        </TooltipTrigger>
        <TooltipContent>Tooltip on text</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" className="cursor-help">
            Badge Trigger
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Tooltip on a badge</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button className="rounded-full p-2 hover:bg-muted">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent>Information tooltip</TooltipContent>
      </Tooltip>
    </div>
  ),
};

// Content variations
export const ContentVariations: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Short</Button>
        </TooltipTrigger>
        <TooltipContent>Save</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Long Text</Button>
        </TooltipTrigger>
        <TooltipContent>
          This is a longer tooltip with more detailed information about the
          action
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Multi-line</Button>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1">
            <p className="font-semibold">Keyboard Shortcut</p>
            <p>Press Ctrl+S to save</p>
            <p className="text-xs opacity-70">Or Cmd+S on Mac</p>
          </div>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">With Icon</Button>
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex items-center gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 2v20M2 12h20" />
            </svg>
            Add new item
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  ),
};

// With delay
export const WithDelay: Story = {
  render: () => (
    <div className="flex gap-4">
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">No Delay (0ms)</Button>
          </TooltipTrigger>
          <TooltipContent>Shows immediately</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Short Delay (200ms)</Button>
          </TooltipTrigger>
          <TooltipContent>Shows after 200ms</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider delayDuration={700}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Long Delay (700ms)</Button>
          </TooltipTrigger>
          <TooltipContent>Shows after 700ms</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ),
};

// Custom styling
export const CustomStyling: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Default Style</Button>
        </TooltipTrigger>
        <TooltipContent>Default tooltip appearance</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Custom Background</Button>
        </TooltipTrigger>
        <TooltipContent className="bg-blue-600 text-white">
          Blue background tooltip
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Large Text</Button>
        </TooltipTrigger>
        <TooltipContent className="text-base">Larger text size</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Wide Padding</Button>
        </TooltipTrigger>
        <TooltipContent className="px-6 py-3">Extra padding</TooltipContent>
      </Tooltip>
    </div>
  ),
};

// Icon buttons with tooltips
export const IconButtons: Story = {
  render: () => (
    <div className="flex gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 12h18m-9-9v18" />
            </svg>
            <span className="sr-only">Add</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add item</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span className="sr-only">Edit</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Edit item</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span className="sr-only">Copy</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy to clipboard</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14M10 11v6M14 11v6" />
            </svg>
            <span className="sr-only">Delete</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete item</TooltipContent>
      </Tooltip>
    </div>
  ),
};

// Disabled trigger
export const DisabledTrigger: Story = {
  render: () => (
    <div className="flex gap-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block">
            <Button disabled>Disabled Button</Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>This action is currently unavailable</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block">
            <Button variant="outline" disabled>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 2v20M2 12h20" />
              </svg>
              Add Item
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          You don&apos;t have permission to add items
        </TooltipContent>
      </Tooltip>
    </div>
  ),
};

// Form field with tooltip
export const FormFieldTooltip: Story = {
  render: () => (
    <div className="w-full max-w-sm space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label htmlFor="username" className="text-sm font-medium">
            Username
          </label>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="text-muted-foreground hover:text-foreground">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Your username must be unique and contain only letters, numbers,
              and underscores
            </TooltipContent>
          </Tooltip>
        </div>
        <input
          id="username"
          type="text"
          placeholder="Enter username"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="text-muted-foreground hover:text-foreground">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              We&apos;ll use this email for account notifications and password
              recovery
            </TooltipContent>
          </Tooltip>
        </div>
        <input
          id="email"
          type="email"
          placeholder="Enter email"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
        />
      </div>
    </div>
  ),
};

// Multiple tooltips in a row
export const MultipleTooltips: Story = {
  render: () => (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm">
            Home
          </Button>
        </TooltipTrigger>
        <TooltipContent>Go to homepage</TooltipContent>
      </Tooltip>

      <span className="text-muted-foreground">/</span>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm">
            Products
          </Button>
        </TooltipTrigger>
        <TooltipContent>Browse all products</TooltipContent>
      </Tooltip>

      <span className="text-muted-foreground">/</span>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm">
            Electronics
          </Button>
        </TooltipTrigger>
        <TooltipContent>Electronics category</TooltipContent>
      </Tooltip>

      <span className="text-muted-foreground">/</span>

      <Tooltip>
        <TooltipTrigger asChild>
          <span className="px-2 text-sm">Laptop</span>
        </TooltipTrigger>
        <TooltipContent>Current page</TooltipContent>
      </Tooltip>
    </div>
  ),
};

// Playground - interactive story
export const Playground: Story = {
  render: (args) => (
    <Tooltip {...args}>
      <TooltipTrigger asChild>
        <Button variant="outline">Hover for tooltip</Button>
      </TooltipTrigger>
      <TooltipContent>Interactive tooltip content</TooltipContent>
    </Tooltip>
  ),
  args: {
    defaultOpen: false,
  },
};
