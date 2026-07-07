import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from './command';
import { Button } from './button';
import {
  CalendarIcon,
  IdCardIcon,
  EnvelopeClosedIcon,
  FaceIcon,
  GearIcon,
  PersonIcon,
  RocketIcon,
} from '@radix-ui/react-icons';

const meta = {
  title: 'Foundations/Primitives/Command',
  component: Command,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

// Basic command menu
export const Default: Story = {
  render: () => (
    <div className="w-96 rounded-lg border">
      <Command>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Suggestions">
            <CommandItem>
              <CalendarIcon className="mr-2 h-4 w-4" />
              <span>Calendar</span>
            </CommandItem>
            <CommandItem>
              <FaceIcon className="mr-2 h-4 w-4" />
              <span>Search Emoji</span>
            </CommandItem>
            <CommandItem>
              <RocketIcon className="mr-2 h-4 w-4" />
              <span>Launch</span>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Settings">
            <CommandItem>
              <PersonIcon className="mr-2 h-4 w-4" />
              <span>Profile</span>
              <CommandShortcut>⌘P</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <IdCardIcon className="mr-2 h-4 w-4" />
              <span>Billing</span>
              <CommandShortcut>⌘B</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <GearIcon className="mr-2 h-4 w-4" />
              <span>Settings</span>
              <CommandShortcut>⌘S</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  ),
};

// Command menu with keyboard shortcuts
export const WithShortcuts: Story = {
  render: () => (
    <div className="w-96 rounded-lg border">
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem>
              <span>New Document</span>
              <CommandShortcut>⌘N</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <span>Open File</span>
              <CommandShortcut>⌘O</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <span>Save</span>
              <CommandShortcut>⌘S</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <span>Save As...</span>
              <CommandShortcut>⇧⌘S</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <span>Print</span>
              <CommandShortcut>⌘P</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  ),
};

// Command menu with multiple groups
export const MultipleGroups: Story = {
  render: () => (
    <div className="w-96 rounded-lg border">
      <Command>
        <CommandInput placeholder="Search for apps, files, or settings..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Applications">
            <CommandItem>
              <RocketIcon className="mr-2 h-4 w-4" />
              <span>Browser</span>
            </CommandItem>
            <CommandItem>
              <CalendarIcon className="mr-2 h-4 w-4" />
              <span>Calendar</span>
            </CommandItem>
            <CommandItem>
              <EnvelopeClosedIcon className="mr-2 h-4 w-4" />
              <span>Mail</span>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Recent Files">
            <CommandItem>
              <span className="text-muted-foreground">~/Documents/</span>
              <span>report.pdf</span>
            </CommandItem>
            <CommandItem>
              <span className="text-muted-foreground">~/Pictures/</span>
              <span>vacation.jpg</span>
            </CommandItem>
            <CommandItem>
              <span className="text-muted-foreground">~/Downloads/</span>
              <span>invoice.xlsx</span>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="System">
            <CommandItem>
              <PersonIcon className="mr-2 h-4 w-4" />
              <span>User Accounts</span>
            </CommandItem>
            <CommandItem>
              <GearIcon className="mr-2 h-4 w-4" />
              <span>System Preferences</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  ),
};

// Command dialog (modal)
export const DialogExample: Story = {
  render: () => {
    const CommandDialogDemo = () => {
      const [open, setOpen] = useState(false);

      return (
        <>
          <Button onClick={() => setOpen(true)}>
            Open Command Palette (⌘K)
          </Button>
          <CommandDialog open={open} onOpenChange={setOpen}>
            <CommandInput placeholder="Type a command or search..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Suggestions">
                <CommandItem onSelect={() => setOpen(false)}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  <span>Calendar</span>
                </CommandItem>
                <CommandItem onSelect={() => setOpen(false)}>
                  <FaceIcon className="mr-2 h-4 w-4" />
                  <span>Search Emoji</span>
                </CommandItem>
                <CommandItem onSelect={() => setOpen(false)}>
                  <RocketIcon className="mr-2 h-4 w-4" />
                  <span>Launch</span>
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Settings">
                <CommandItem onSelect={() => setOpen(false)}>
                  <PersonIcon className="mr-2 h-4 w-4" />
                  <span>Profile</span>
                  <CommandShortcut>⌘P</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={() => setOpen(false)}>
                  <IdCardIcon className="mr-2 h-4 w-4" />
                  <span>Billing</span>
                  <CommandShortcut>⌘B</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={() => setOpen(false)}>
                  <GearIcon className="mr-2 h-4 w-4" />
                  <span>Settings</span>
                  <CommandShortcut>⌘S</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
        </>
      );
    };

    return <CommandDialogDemo />;
  },
};

// Empty state
export const EmptyState: Story = {
  render: () => (
    <div className="w-96 rounded-lg border">
      <Command>
        <CommandInput
          placeholder="Search for something that doesn't exist..."
          value="xyz123"
        />
        <CommandList>
          <CommandEmpty>No results found for &quot;xyz123&quot;</CommandEmpty>
        </CommandList>
      </Command>
    </div>
  ),
};

// Disabled items
export const DisabledItems: Story = {
  render: () => (
    <div className="w-96 rounded-lg border">
      <Command>
        <CommandInput placeholder="Type a command..." />
        <CommandList>
          <CommandGroup heading="Options">
            <CommandItem>
              <span>Active Option</span>
            </CommandItem>
            <CommandItem disabled>
              <span className="opacity-50">Disabled Option</span>
            </CommandItem>
            <CommandItem>
              <span>Another Active Option</span>
            </CommandItem>
            <CommandItem disabled>
              <span className="opacity-50">Another Disabled Option</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  ),
};

// Loading state (using disabled items as placeholder)
export const LoadingState: Story = {
  render: () => (
    <div className="w-96 rounded-lg border">
      <Command>
        <CommandInput placeholder="Loading results..." />
        <CommandList>
          <CommandGroup heading="Loading...">
            <CommandItem disabled>
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-pulse rounded bg-muted" />
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              </div>
            </CommandItem>
            <CommandItem disabled>
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-pulse rounded bg-muted" />
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              </div>
            </CommandItem>
            <CommandItem disabled>
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-pulse rounded bg-muted" />
                <div className="h-4 w-28 animate-pulse rounded bg-muted" />
              </div>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  ),
};

// Interactive example with state
export const Interactive: Story = {
  render: () => {
    const InteractiveCommand = () => {
      const [value, setValue] = useState('');
      const [selectedItem, setSelectedItem] = useState<string | null>(null);

      return (
        <div className="space-y-4">
          <div className="w-96 rounded-lg border">
            <Command value={value} onValueChange={setValue}>
              <CommandInput placeholder="Type to search..." />
              <CommandList>
                <CommandEmpty>No results found.</CommandEmpty>
                <CommandGroup heading="Fruits">
                  <CommandItem
                    value="apple"
                    onSelect={(value) => setSelectedItem(value)}
                  >
                    🍎 Apple
                  </CommandItem>
                  <CommandItem
                    value="banana"
                    onSelect={(value) => setSelectedItem(value)}
                  >
                    🍌 Banana
                  </CommandItem>
                  <CommandItem
                    value="orange"
                    onSelect={(value) => setSelectedItem(value)}
                  >
                    🍊 Orange
                  </CommandItem>
                  <CommandItem
                    value="grape"
                    onSelect={(value) => setSelectedItem(value)}
                  >
                    🍇 Grape
                  </CommandItem>
                  <CommandItem
                    value="strawberry"
                    onSelect={(value) => setSelectedItem(value)}
                  >
                    🍓 Strawberry
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
          {selectedItem && (
            <div className="text-sm text-muted-foreground">
              Selected:{' '}
              <span className="font-medium text-foreground">
                {selectedItem}
              </span>
            </div>
          )}
        </div>
      );
    };

    return <InteractiveCommand />;
  },
};
