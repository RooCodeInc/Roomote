import React from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';

const meta = {
  title: 'Foundations/Primitives/Popover',
  component: Popover,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default popover
export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Open Popover</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div>
          <h4 className="font-medium leading-none">Popover Title</h4>
          <p className="text-sm text-muted-foreground mt-2">
            This is the popover content. You can place any content here.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  ),
};

// Different positions
export const Positions: Story = {
  render: () => (
    <div
      className="grid grid-cols-3 gap-12"
      style={{ minHeight: '400px', minWidth: '600px', placeItems: 'center' }}
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            Top
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top">
          <p className="text-sm">Popover aligned to top</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            Bottom
          </Button>
        </PopoverTrigger>
        <PopoverContent side="bottom">
          <p className="text-sm">Popover aligned to bottom</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            Right
          </Button>
        </PopoverTrigger>
        <PopoverContent side="right">
          <p className="text-sm">Popover aligned to right</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            Left
          </Button>
        </PopoverTrigger>
        <PopoverContent side="left">
          <p className="text-sm">Popover aligned to left</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            Default (Center)
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <p className="text-sm">Default center alignment</p>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

// Different alignments
export const Alignments: Story = {
  render: () => (
    <div className="flex gap-8 items-center" style={{ minHeight: '200px' }}>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Start Aligned</Button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <p className="text-sm">Content aligned to start</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Center Aligned</Button>
        </PopoverTrigger>
        <PopoverContent align="center">
          <p className="text-sm">Content aligned to center</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">End Aligned</Button>
        </PopoverTrigger>
        <PopoverContent align="end">
          <p className="text-sm">Content aligned to end</p>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

// Different trigger types
export const TriggerTypes: Story = {
  render: () => (
    <div className="flex gap-4 items-center">
      <Popover>
        <PopoverTrigger asChild>
          <Button>Button Trigger</Button>
        </PopoverTrigger>
        <PopoverContent>
          <p className="text-sm">Triggered by a button</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <span className="cursor-pointer text-blue-600 hover:underline">
            Link Trigger
          </span>
        </PopoverTrigger>
        <PopoverContent>
          <p className="text-sm">Triggered by a link</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <div className="p-2 border rounded cursor-pointer hover:bg-gray-50">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </div>
        </PopoverTrigger>
        <PopoverContent>
          <p className="text-sm">Triggered by an icon</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger className="px-3 py-1 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80">
          Custom Element
        </PopoverTrigger>
        <PopoverContent>
          <p className="text-sm">Triggered by a custom element</p>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

// Rich content examples
export const RichContent: Story = {
  render: () => (
    <div className="flex gap-4">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">User Profile</Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="space-y-3">
            <div className="flex items-center space-x-3">
              <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center">
                <span className="text-lg font-semibold">JD</span>
              </div>
              <div>
                <h4 className="font-semibold">John Doe</h4>
                <p className="text-sm text-muted-foreground">
                  john.doe@example.com
                </p>
              </div>
            </div>
            <div className="border-t pt-3 space-y-1">
              <button className="w-full text-left px-2 py-1 text-sm hover:bg-gray-100 rounded">
                Profile Settings
              </button>
              <button className="w-full text-left px-2 py-1 text-sm hover:bg-gray-100 rounded">
                Account
              </button>
              <button className="w-full text-left px-2 py-1 text-sm hover:bg-gray-100 rounded">
                Sign Out
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Settings Form</Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="grid gap-4">
            <div className="space-y-2">
              <h4 className="font-medium leading-none">Dimensions</h4>
              <p className="text-sm text-muted-foreground">
                Set the dimensions for the layer.
              </p>
            </div>
            <div className="grid gap-2">
              <div className="grid grid-cols-3 items-center gap-4">
                <Label htmlFor="width">Width</Label>
                <Input
                  id="width"
                  defaultValue="100%"
                  className="col-span-2 h-8"
                />
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <Label htmlFor="maxWidth">Max. width</Label>
                <Input
                  id="maxWidth"
                  defaultValue="300px"
                  className="col-span-2 h-8"
                />
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <Label htmlFor="height">Height</Label>
                <Input
                  id="height"
                  defaultValue="25px"
                  className="col-span-2 h-8"
                />
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <Label htmlFor="maxHeight">Max. height</Label>
                <Input
                  id="maxHeight"
                  defaultValue="none"
                  className="col-span-2 h-8"
                />
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Info Card</Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold">Quick Tips</h4>
              <span className="text-xs text-muted-foreground">v2.0.1</span>
            </div>
            <div className="space-y-3">
              <div className="flex gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 mt-1.5 shrink-0"></div>
                <div>
                  <p className="text-sm font-medium">Keyboard Shortcuts</p>
                  <p className="text-xs text-muted-foreground">
                    Press ⌘K to open command menu
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 shrink-0"></div>
                <div>
                  <p className="text-sm font-medium">Search Everything</p>
                  <p className="text-xs text-muted-foreground">
                    Use the search bar to find anything
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="w-2 h-2 rounded-full bg-purple-500 mt-1.5 shrink-0"></div>
                <div>
                  <p className="text-sm font-medium">Dark Mode</p>
                  <p className="text-xs text-muted-foreground">
                    Toggle dark mode in settings
                  </p>
                </div>
              </div>
            </div>
            <div className="pt-2 border-t">
              <a href="#" className="text-xs text-blue-600 hover:underline">
                View all tips →
              </a>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

// Controlled state example
export const ControlledState: Story = {
  render: () => {
    const [open, setOpen] = React.useState(false);

    return (
      <div className="space-y-4">
        <div className="space-x-2">
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            disabled={open}
          >
            Open Popover Externally
          </Button>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={!open}
          >
            Close Popover Externally
          </Button>
        </div>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="default">
              {open ? 'Popover is Open' : 'Click to Toggle'}
            </Button>
          </PopoverTrigger>
          <PopoverContent>
            <div className="space-y-2">
              <h4 className="font-medium">Controlled Popover</h4>
              <p className="text-sm text-muted-foreground">
                This popover&apos;s open state is controlled externally.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Close from Inside
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <p className="text-sm text-muted-foreground">
          Current state:{' '}
          <span className="font-medium">{open ? 'Open' : 'Closed'}</span>
        </p>
      </div>
    );
  },
};

// With offset
export const WithOffset: Story = {
  render: () => (
    <div className="flex gap-4">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">No Offset</Button>
        </PopoverTrigger>
        <PopoverContent sideOffset={0}>
          <p className="text-sm">No offset from trigger</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Default Offset (4px)</Button>
        </PopoverTrigger>
        <PopoverContent>
          <p className="text-sm">Default 4px offset</p>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Large Offset (16px)</Button>
        </PopoverTrigger>
        <PopoverContent sideOffset={16}>
          <p className="text-sm">16px offset from trigger</p>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

// Custom styling
export const CustomStyling: Story = {
  render: () => (
    <div className="flex gap-4">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Dark Theme</Button>
        </PopoverTrigger>
        <PopoverContent className="bg-gray-900 text-white border-gray-700">
          <div>
            <h4 className="font-medium text-white">Dark Popover</h4>
            <p className="text-sm text-gray-300 mt-1">
              Custom dark themed popover content
            </p>
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Colorful</Button>
        </PopoverTrigger>
        <PopoverContent className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200">
          <div>
            <h4 className="font-medium text-purple-900">Gradient Popover</h4>
            <p className="text-sm text-purple-700 mt-1">
              With gradient background
            </p>
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">No Padding</Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 overflow-hidden">
          <div className="bg-gray-100 p-3">
            <p className="text-sm font-medium">Header Section</p>
          </div>
          <div className="p-3">
            <p className="text-sm">Content Section</p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

// Nested popovers
export const NestedPopovers: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button>Open First Popover</Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-3">
          <h4 className="font-medium">First Level Popover</h4>
          <p className="text-sm text-muted-foreground">
            This popover contains another popover trigger.
          </p>

          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline">
                Open Nested
              </Button>
            </PopoverTrigger>
            <PopoverContent side="right" className="w-64">
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Nested Popover</h4>
                <p className="text-xs text-muted-foreground">
                  This is a nested popover. You can have multiple levels.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </PopoverContent>
    </Popover>
  ),
};
