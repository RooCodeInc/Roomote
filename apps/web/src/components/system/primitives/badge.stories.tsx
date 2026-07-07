import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Badge } from './badge';
import { Check, X, AlertCircle, Info } from '@/components/system';

const meta = {
  title: 'Foundations/Primitives/Badge',
  component: Badge,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'secondary', 'destructive', 'outline'],
      description: 'The visual style variant of the badge',
    },
    asChild: {
      control: 'boolean',
      description: 'Whether to render as a child component using Radix UI Slot',
    },
    children: {
      control: 'text',
      description: 'The content of the badge',
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default badge
export const Default: Story = {
  args: {
    children: 'Badge',
    variant: 'default',
  },
};

// All variants
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="outline">Outline</Badge>
    </div>
  ),
};

// With icons
export const WithIcons: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Badge>
        <Check className="h-3 w-3" />
        Success
      </Badge>
      <Badge variant="secondary">
        <Info className="h-3 w-3" />
        Info
      </Badge>
      <Badge variant="destructive">
        <X className="h-3 w-3" />
        Error
      </Badge>
      <Badge variant="outline">
        <AlertCircle className="h-3 w-3" />
        Warning
      </Badge>
    </div>
  ),
};

// Status badges
export const StatusBadges: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Badge>Active</Badge>
      <Badge variant="secondary">Pending</Badge>
      <Badge variant="destructive">Failed</Badge>
      <Badge variant="outline">Draft</Badge>
    </div>
  ),
};

// Notification badges
export const NotificationBadges: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Badge>New</Badge>
      <Badge variant="destructive">99+</Badge>
      <Badge variant="secondary">3</Badge>
      <Badge variant="outline">42</Badge>
    </div>
  ),
};

// Label badges
export const LabelBadges: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge>React</Badge>
      <Badge>TypeScript</Badge>
      <Badge>Next.js</Badge>
      <Badge>Tailwind CSS</Badge>
      <Badge>Storybook</Badge>
    </div>
  ),
};

// Category badges
export const CategoryBadges: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">Design</Badge>
      <Badge variant="outline">Development</Badge>
      <Badge variant="outline">Marketing</Badge>
      <Badge variant="outline">Sales</Badge>
    </div>
  ),
};

// As Child example (badge as a link)
export const AsChild: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Badge asChild>
        <a href="#" onClick={(e) => e.preventDefault()}>
          Clickable Badge
        </a>
      </Badge>
      <Badge variant="outline" asChild>
        <a href="#" onClick={(e) => e.preventDefault()}>
          Link Badge
        </a>
      </Badge>
    </div>
  ),
};

// Complex examples
export const ComplexExamples: Story = {
  render: () => (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm">Status:</span>
        <Badge>
          <div className="mr-1 h-2 w-2 rounded-full bg-green-500" />
          Online
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm">Build:</span>
        <Badge variant="destructive">
          <X className="h-3 w-3" />
          Failed
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm">Version:</span>
        <Badge variant="secondary">v2.0.0-beta.1</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm">Environment:</span>
        <Badge variant="outline">Production</Badge>
      </div>
    </div>
  ),
};

// Size variations (using custom classes)
export const SizeVariations: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Badge>Extra Small</Badge>
      <Badge>Default</Badge>
      <Badge className="px-3 py-1 text-sm">Large</Badge>
      <Badge className="px-4 py-1.5 text-base">Extra Large</Badge>
    </div>
  ),
};

// Badge groups
export const BadgeGroups: Story = {
  render: () => (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-sm font-medium">Programming Languages</h3>
        <div className="flex flex-wrap gap-1">
          <Badge>JavaScript</Badge>
          <Badge>Python</Badge>
          <Badge>Go</Badge>
          <Badge>Rust</Badge>
          <Badge>Java</Badge>
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">Priority Levels</h3>
        <div className="flex flex-wrap gap-1">
          <Badge variant="destructive">Critical</Badge>
          <Badge variant="destructive">High</Badge>
          <Badge variant="secondary">Medium</Badge>
          <Badge variant="outline">Low</Badge>
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">Task Status</h3>
        <div className="flex flex-wrap gap-1">
          <Badge>
            <Check className="h-3 w-3" />
            Completed
          </Badge>
          <Badge variant="secondary">
            <div className="mr-1 h-2 w-2 rounded-full bg-yellow-500" />
            In Progress
          </Badge>
          <Badge variant="outline">
            <div className="mr-1 h-2 w-2 rounded-full bg-gray-400" />
            Todo
          </Badge>
        </div>
      </div>
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    children: 'Playground Badge',
    variant: 'default',
    asChild: false,
  },
};
