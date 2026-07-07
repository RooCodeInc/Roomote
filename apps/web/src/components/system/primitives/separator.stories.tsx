import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Separator } from './separator';

const meta = {
  title: 'Foundations/Primitives/Separator',
  component: Separator,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    orientation: {
      control: 'select',
      options: ['horizontal', 'vertical'],
      description: 'The orientation of the separator',
    },
    decorative: {
      control: 'boolean',
      description: 'Whether the separator is decorative or semantic',
    },
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
  },
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default horizontal separator
export const Default: Story = {
  render: () => (
    <div className="w-96">
      <div className="space-y-1">
        <h4 className="text-sm font-medium leading-none">Project Details</h4>
        <p className="text-sm text-muted-foreground">
          Manage your project settings and preferences.
        </p>
      </div>
      <Separator className="my-4" />
      <div className="flex h-5 items-center space-x-4 text-sm">
        <div>Blog</div>
        <Separator orientation="vertical" />
        <div>Docs</div>
        <Separator orientation="vertical" />
        <div>Source</div>
      </div>
    </div>
  ),
};

// Horizontal orientation
export const Horizontal: Story = {
  render: () => (
    <div className="w-96 space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Section One</h3>
        <p className="text-sm text-muted-foreground">
          This is the first section of content.
        </p>
      </div>
      <Separator />
      <div>
        <h3 className="text-lg font-semibold">Section Two</h3>
        <p className="text-sm text-muted-foreground">
          This is the second section of content.
        </p>
      </div>
      <Separator />
      <div>
        <h3 className="text-lg font-semibold">Section Three</h3>
        <p className="text-sm text-muted-foreground">
          This is the third section of content.
        </p>
      </div>
    </div>
  ),
};

// Vertical orientation
export const Vertical: Story = {
  render: () => (
    <div className="flex h-20 items-center space-x-4">
      <div className="text-center">
        <div className="text-2xl font-bold">24</div>
        <div className="text-xs text-muted-foreground">Active</div>
      </div>
      <Separator orientation="vertical" />
      <div className="text-center">
        <div className="text-2xl font-bold">89</div>
        <div className="text-xs text-muted-foreground">Pending</div>
      </div>
      <Separator orientation="vertical" />
      <div className="text-center">
        <div className="text-2xl font-bold">147</div>
        <div className="text-xs text-muted-foreground">Completed</div>
      </div>
    </div>
  ),
};

// With different spacing
export const DifferentSpacing: Story = {
  render: () => (
    <div className="w-96">
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Tight Spacing</h4>
        <p className="text-sm text-muted-foreground">Content above separator</p>
        <Separator className="my-2" />
        <p className="text-sm text-muted-foreground">Content below separator</p>
      </div>

      <div className="mt-8 space-y-4">
        <h4 className="text-sm font-medium">Normal Spacing</h4>
        <p className="text-sm text-muted-foreground">Content above separator</p>
        <Separator className="my-4" />
        <p className="text-sm text-muted-foreground">Content below separator</p>
      </div>

      <div className="mt-8 space-y-6">
        <h4 className="text-sm font-medium">Wide Spacing</h4>
        <p className="text-sm text-muted-foreground">Content above separator</p>
        <Separator className="my-8" />
        <p className="text-sm text-muted-foreground">Content below separator</p>
      </div>
    </div>
  ),
};

// Custom styles
export const CustomStyles: Story = {
  render: () => (
    <div className="w-96 space-y-8">
      <div>
        <h4 className="text-sm font-medium mb-4">Default Style</h4>
        <Separator />
      </div>

      <div>
        <h4 className="text-sm font-medium mb-4">Thicker Separator</h4>
        <Separator className="h-0.5" />
      </div>

      <div>
        <h4 className="text-sm font-medium mb-4">Dashed Style</h4>
        <div className="border-t border-dashed" />
      </div>

      <div>
        <h4 className="text-sm font-medium mb-4">Dotted Style</h4>
        <div className="border-t border-dotted" />
      </div>

      <div>
        <h4 className="text-sm font-medium mb-4">Colored Separator</h4>
        <Separator className="bg-primary" />
      </div>

      <div>
        <h4 className="text-sm font-medium mb-4">Gradient Separator</h4>
        <div className="h-px bg-gradient-to-r from-transparent via-foreground/50 to-transparent" />
      </div>
    </div>
  ),
};

// In navigation menu
export const InNavigation: Story = {
  render: () => (
    <nav className="w-64 border rounded-lg p-2">
      <div className="space-y-1">
        <button className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent">
          Dashboard
        </button>
        <button className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent">
          Analytics
        </button>
        <button className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent">
          Reports
        </button>
      </div>
      <Separator className="my-2" />
      <div className="space-y-1">
        <button className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent">
          Team
        </button>
        <button className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent">
          Projects
        </button>
      </div>
      <Separator className="my-2" />
      <div className="space-y-1">
        <button className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent">
          Settings
        </button>
        <button className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent">
          Support
        </button>
      </div>
    </nav>
  ),
};

// In card layout
export const InCard: Story = {
  render: () => (
    <div className="w-96 border rounded-lg">
      <div className="p-6">
        <h3 className="text-lg font-semibold">Account Settings</h3>
        <p className="text-sm text-muted-foreground mt-2">
          Manage your account preferences and security settings.
        </p>
      </div>
      <Separator />
      <div className="p-6 space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm font-medium">Email Notifications</p>
            <p className="text-xs text-muted-foreground">
              Receive email updates
            </p>
          </div>
          <button className="text-sm text-primary hover:underline">Edit</button>
        </div>
        <Separator />
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm font-medium">Two-Factor Authentication</p>
            <p className="text-xs text-muted-foreground">
              Extra security for your account
            </p>
          </div>
          <button className="text-sm text-primary hover:underline">
            Enable
          </button>
        </div>
        <Separator />
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm font-medium">Password</p>
            <p className="text-xs text-muted-foreground">
              Last changed 3 months ago
            </p>
          </div>
          <button className="text-sm text-primary hover:underline">
            Update
          </button>
        </div>
      </div>
    </div>
  ),
};

// In toolbar
export const InToolbar: Story = {
  render: () => (
    <div className="flex items-center space-x-2 border rounded-lg p-2">
      <button className="p-2 hover:bg-accent rounded">
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V2"
          />
        </svg>
      </button>
      <button className="p-2 hover:bg-accent rounded">
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
          />
        </svg>
      </button>
      <Separator orientation="vertical" className="h-6" />
      <button className="p-2 hover:bg-accent rounded">
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      </button>
      <button className="p-2 hover:bg-accent rounded">
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
      </button>
      <Separator orientation="vertical" className="h-6" />
      <button className="p-2 hover:bg-accent rounded">
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
          />
        </svg>
      </button>
    </div>
  ),
};

// With text
export const WithText: Story = {
  render: () => (
    <div className="w-96 space-y-8">
      <div className="relative">
        <Separator />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
          OR
        </span>
      </div>

      <div className="relative">
        <Separator />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
          Continue with
        </span>
      </div>

      <div className="flex items-center">
        <Separator className="flex-1" />
        <span className="px-3 text-xs text-muted-foreground">
          Section Break
        </span>
        <Separator className="flex-1" />
      </div>
    </div>
  ),
};

// In list
export const InList: Story = {
  render: () => (
    <ul className="w-96 border rounded-lg divide-y">
      <li className="p-4">
        <div className="flex justify-between items-start">
          <div>
            <p className="font-medium">Item One</p>
            <p className="text-sm text-muted-foreground">
              Description for the first item
            </p>
          </div>
          <span className="text-sm text-muted-foreground">$29.99</span>
        </div>
      </li>
      <li className="p-4">
        <div className="flex justify-between items-start">
          <div>
            <p className="font-medium">Item Two</p>
            <p className="text-sm text-muted-foreground">
              Description for the second item
            </p>
          </div>
          <span className="text-sm text-muted-foreground">$39.99</span>
        </div>
      </li>
      <li className="p-4">
        <div className="flex justify-between items-start">
          <div>
            <p className="font-medium">Item Three</p>
            <p className="text-sm text-muted-foreground">
              Description for the third item
            </p>
          </div>
          <span className="text-sm text-muted-foreground">$49.99</span>
        </div>
      </li>
    </ul>
  ),
};

// In footer
export const InFooter: Story = {
  render: () => (
    <footer className="w-full max-w-3xl">
      <div className="flex justify-between items-center py-4">
        <p className="text-sm text-muted-foreground">© 2024 Company Name</p>
        <div className="flex items-center space-x-4 text-sm">
          <a href="#" className="hover:underline">
            Privacy
          </a>
          <Separator orientation="vertical" className="h-4" />
          <a href="#" className="hover:underline">
            Terms
          </a>
          <Separator orientation="vertical" className="h-4" />
          <a href="#" className="hover:underline">
            Contact
          </a>
        </div>
      </div>
      <Separator />
      <div className="py-4 flex items-center justify-between">
        <div className="flex space-x-4">
          <a href="#" className="text-sm hover:underline">
            Twitter
          </a>
          <a href="#" className="text-sm hover:underline">
            GitHub
          </a>
          <a href="#" className="text-sm hover:underline">
            LinkedIn
          </a>
        </div>
        <select className="text-sm border rounded px-2 py-1">
          <option>English</option>
          <option>Español</option>
          <option>Français</option>
        </select>
      </div>
    </footer>
  ),
};

// Playground
export const Playground: Story = {
  args: {
    orientation: 'horizontal',
    decorative: true,
  },
  render: (args) => (
    <div
      className={
        args.orientation === 'horizontal' ? 'w-96' : 'h-20 flex items-center'
      }
    >
      {args.orientation === 'horizontal' ? (
        <>
          <p className="text-sm">Content above the separator</p>
          <Separator {...args} className="my-4" />
          <p className="text-sm">Content below the separator</p>
        </>
      ) : (
        <>
          <p className="text-sm">Left content</p>
          <Separator {...args} className="mx-4" />
          <p className="text-sm">Right content</p>
        </>
      )}
    </div>
  ),
};
