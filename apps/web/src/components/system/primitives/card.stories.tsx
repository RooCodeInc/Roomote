import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Button } from './button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CardAction,
} from './card';

const meta = {
  title: 'Foundations/Primitives/Card',
  component: Card,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'snug'],
      description: 'The spacing variant of the card',
    },
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
    children: {
      description: 'The content of the card',
    },
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default card with all components
export const Default: Story = {
  render: () => (
    <Card className="w-[350px]">
      <CardHeader>
        <CardTitle>Card Title</CardTitle>
        <CardDescription>Card description goes here</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm">
          This is the card content. You can put any content here.
        </p>
      </CardContent>
      <CardFooter>
        <Button size="sm">Action</Button>
      </CardFooter>
    </Card>
  ),
};

// Complete card with all elements
export const Complete: Story = {
  render: () => (
    <Card className="w-[400px]">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>You have 3 unread messages.</CardDescription>
        <CardAction>
          <Button size="sm" variant="outline">
            Mark all as read
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex items-start space-x-4 rounded-lg border p-4">
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium">
                Your call has been confirmed.
              </p>
              <p className="text-sm text-muted-foreground">1 hour ago</p>
            </div>
          </div>
          <div className="flex items-start space-x-4 rounded-lg border p-4">
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium">You have a new message!</p>
              <p className="text-sm text-muted-foreground">2 hours ago</p>
            </div>
          </div>
        </div>
      </CardContent>
      <CardFooter align="between">
        <Button variant="ghost" size="sm">
          Dismiss
        </Button>
        <Button size="sm">View all</Button>
      </CardFooter>
    </Card>
  ),
};

// Card with header only
export const HeaderOnly: Story = {
  render: () => (
    <Card className="w-[350px]">
      <CardHeader>
        <CardTitle>Simple Card</CardTitle>
        <CardDescription>
          This card only has a header with title and description
        </CardDescription>
      </CardHeader>
    </Card>
  ),
};

// Card with content only
export const ContentOnly: Story = {
  render: () => (
    <Card className="w-[350px]">
      <CardContent>
        <p className="text-sm">
          This is a simple card with only content. No header or footer.
        </p>
      </CardContent>
    </Card>
  ),
};

// Card variants
export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Card className="w-[350px]" variant="default">
        <CardHeader>
          <CardTitle>Default Variant</CardTitle>
          <CardDescription>More spacious padding (gap-6 py-6)</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">Content with default spacing</p>
        </CardContent>
      </Card>
      <Card className="w-[350px]" variant="snug">
        <CardHeader>
          <CardTitle>Snug Variant</CardTitle>
          <CardDescription>Compact padding (gap-3 py-4)</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">Content with snug spacing</p>
        </CardContent>
      </Card>
    </div>
  ),
};

// Card with action button in header
export const WithHeaderAction: Story = {
  render: () => (
    <Card className="w-[400px]">
      <CardHeader>
        <CardTitle>Project Settings</CardTitle>
        <CardDescription>Manage your project configuration</CardDescription>
        <CardAction>
          <Button size="icon" variant="ghost">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm">API Access</span>
            <span className="text-sm text-muted-foreground">Enabled</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Team Members</span>
            <span className="text-sm text-muted-foreground">12</span>
          </div>
        </div>
      </CardContent>
    </Card>
  ),
};

// Form card example
export const FormExample: Story = {
  render: () => (
    <Card className="w-[400px]">
      <CardHeader>
        <CardTitle>Create Account</CardTitle>
        <CardDescription>
          Enter your email below to create your account
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              placeholder="m@example.com"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>
      </CardContent>
      <CardFooter align="between">
        <Button variant="ghost">Cancel</Button>
        <Button>Create Account</Button>
      </CardFooter>
    </Card>
  ),
};

// Pricing card example
export const PricingCard: Story = {
  render: () => (
    <Card className="w-[300px]">
      <CardHeader className="text-center">
        <CardTitle>Pro Plan</CardTitle>
        <CardDescription>Best for growing teams</CardDescription>
      </CardHeader>
      <CardContent className="text-center">
        <div className="text-4xl font-bold">$29</div>
        <div className="text-sm text-muted-foreground">per month</div>
        <ul className="mt-6 space-y-2 text-left text-sm">
          <li className="flex items-center">
            <svg
              className="mr-2 h-4 w-4 text-green-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            Unlimited projects
          </li>
          <li className="flex items-center">
            <svg
              className="mr-2 h-4 w-4 text-green-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            Up to 10 team members
          </li>
          <li className="flex items-center">
            <svg
              className="mr-2 h-4 w-4 text-green-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            Priority support
          </li>
        </ul>
      </CardContent>
      <CardFooter>
        <Button className="w-full">Get Started</Button>
      </CardFooter>
    </Card>
  ),
};

// Interactive playground
export const Playground: Story = {
  args: {
    variant: 'default',
    className: 'w-[350px]',
    children: (
      <>
        <CardHeader>
          <CardTitle>Playground Card</CardTitle>
          <CardDescription>Experiment with different variants</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            Use the controls to change the card variant.
          </p>
        </CardContent>
        <CardFooter>
          <Button size="sm">Footer Action</Button>
        </CardFooter>
      </>
    ),
  },
};
