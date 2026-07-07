import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';
import { Button } from './button';
import { Badge } from './badge';
import {
  CalendarIcon,
  EnvelopeOpenIcon,
  FaceIcon,
  GlobeIcon,
  LinkedInLogoIcon,
  TwitterLogoIcon,
  GitHubLogoIcon,
  StarIcon,
} from '@radix-ui/react-icons';

const meta = {
  title: 'Foundations/Primitives/HoverCard',
  component: HoverCard,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    openDelay: {
      control: { type: 'number', min: 0, max: 1000, step: 100 },
      description:
        'The duration from when the mouse enters the trigger until the hover card opens.',
    },
    closeDelay: {
      control: { type: 'number', min: 0, max: 1000, step: 100 },
      description:
        'The duration from when the mouse leaves the trigger until the hover card closes.',
    },
  },
} satisfies Meta<typeof HoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// Basic hover card
export const Default: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button variant="link">@nextjs</Button>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="flex justify-between space-x-4">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold">@nextjs</h4>
            <p className="text-sm">
              The React Framework – created and maintained by @vercel.
            </p>
            <div className="flex items-center pt-2">
              <CalendarIcon className="mr-2 h-4 w-4 opacity-70" />
              <span className="text-xs text-muted-foreground">
                Joined December 2021
              </span>
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};

// User profile hover card
export const UserProfile: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button variant="link" className="p-0 h-auto">
          <div className="flex items-center">
            <div className="h-8 w-8 rounded-full bg-slate-200 flex items-center justify-center mr-2">
              <span className="text-sm font-semibold">SC</span>
            </div>
            <span>@shadcn</span>
          </div>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <div className="flex space-x-4">
          <div className="h-12 w-12 rounded-full bg-slate-200 flex items-center justify-center">
            <span className="text-lg font-semibold">SC</span>
          </div>
          <div className="space-y-1 flex-1">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">shadcn</h4>
              <Button variant="outline" size="sm">
                Follow
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Designer & developer. Building beautiful, accessible components.
            </p>
            <div className="flex items-center pt-2 text-xs text-muted-foreground">
              <CalendarIcon className="mr-2 h-3 w-3" />
              Joined December 2021
            </div>
            <div className="flex gap-3 pt-2">
              <div className="text-xs">
                <span className="font-semibold">1.2k</span>{' '}
                <span className="text-muted-foreground">Following</span>
              </div>
              <div className="text-xs">
                <span className="font-semibold">25.4k</span>{' '}
                <span className="text-muted-foreground">Followers</span>
              </div>
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};

// Product showcase hover card
export const ProductShowcase: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <div className="inline-flex items-center gap-2 cursor-pointer text-blue-600 hover:text-blue-700">
          <span className="underline">Premium Plan</span>
          <Badge variant="secondary">Popular</Badge>
        </div>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <div className="space-y-3">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="font-semibold text-lg">Premium Plan</h3>
              <p className="text-2xl font-bold">
                $29
                <span className="text-sm font-normal text-muted-foreground">
                  /month
                </span>
              </p>
            </div>
            <Badge variant="secondary">Most Popular</Badge>
          </div>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Perfect for growing businesses and teams
            </p>
            <ul className="text-sm space-y-1">
              <li className="flex items-center">
                <span className="mr-2 text-green-500">✓</span>
                Unlimited projects
              </li>
              <li className="flex items-center">
                <span className="mr-2 text-green-500">✓</span>
                Advanced analytics
              </li>
              <li className="flex items-center">
                <span className="mr-2 text-green-500">✓</span>
                Priority support
              </li>
              <li className="flex items-center">
                <span className="mr-2 text-green-500">✓</span>
                Custom integrations
              </li>
            </ul>
          </div>
          <Button className="w-full">Get Started</Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};

// Code snippet hover card
export const CodeSnippet: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <code className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm cursor-help">
          Array.map()
        </code>
      </HoverCardTrigger>
      <HoverCardContent className="w-96">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold font-mono">
              Array.prototype.map()
            </h4>
            <Badge variant="outline">JavaScript</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Creates a new array populated with the results of calling a provided
            function on every element.
          </p>
          <div className="rounded-md bg-slate-950 p-3">
            <code className="text-xs text-white">
              <pre>{`const numbers = [1, 2, 3, 4];
const doubled = numbers.map(x => x * 2);
// Result: [2, 4, 6, 8]`}</pre>
            </code>
          </div>
          <div className="flex items-center text-xs text-muted-foreground pt-2">
            <a href="#" className="hover:underline">
              MDN Documentation →
            </a>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};

// Social media hover card
export const SocialMedia: Story = {
  render: () => (
    <div className="flex gap-4 items-center">
      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="ghost" size="icon">
            <TwitterLogoIcon className="h-4 w-4" />
          </Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <TwitterLogoIcon className="h-5 w-5 text-[#1DA1F2]" />
              <span className="font-semibold">Twitter</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Follow us on Twitter for the latest updates and announcements.
            </p>
            <Button variant="outline" size="sm" className="w-full">
              <TwitterLogoIcon className="mr-2 h-3 w-3" />
              Follow @company
            </Button>
          </div>
        </HoverCardContent>
      </HoverCard>

      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="ghost" size="icon">
            <GitHubLogoIcon className="h-4 w-4" />
          </Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <GitHubLogoIcon className="h-5 w-5" />
              <span className="font-semibold">GitHub</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Star our repository and contribute to open source.
            </p>
            <div className="flex gap-2 text-xs">
              <div className="flex items-center gap-1">
                <StarIcon className="h-3 w-3" />
                <span>12.5k Stars</span>
              </div>
              <div>• 1.2k Forks</div>
            </div>
            <Button variant="outline" size="sm" className="w-full">
              <GitHubLogoIcon className="mr-2 h-3 w-3" />
              View Repository
            </Button>
          </div>
        </HoverCardContent>
      </HoverCard>

      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="ghost" size="icon">
            <LinkedInLogoIcon className="h-4 w-4" />
          </Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <LinkedInLogoIcon className="h-5 w-5 text-[#0077B5]" />
              <span className="font-semibold">LinkedIn</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Connect with us on LinkedIn for professional updates.
            </p>
            <Button variant="outline" size="sm" className="w-full">
              <LinkedInLogoIcon className="mr-2 h-3 w-3" />
              Connect
            </Button>
          </div>
        </HoverCardContent>
      </HoverCard>
    </div>
  ),
};

// Different alignments
export const Alignments: Story = {
  render: () => (
    <div className="flex gap-8 items-center">
      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="outline">Align Start</Button>
        </HoverCardTrigger>
        <HoverCardContent align="start" className="w-64">
          <p className="text-sm">
            This hover card is aligned to the start of the trigger element.
          </p>
        </HoverCardContent>
      </HoverCard>

      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="outline">Align Center</Button>
        </HoverCardTrigger>
        <HoverCardContent align="center" className="w-64">
          <p className="text-sm">
            This hover card is centered relative to the trigger element.
          </p>
        </HoverCardContent>
      </HoverCard>

      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="outline">Align End</Button>
        </HoverCardTrigger>
        <HoverCardContent align="end" className="w-64">
          <p className="text-sm">
            This hover card is aligned to the end of the trigger element.
          </p>
        </HoverCardContent>
      </HoverCard>
    </div>
  ),
};

// Different sides
export const Sides: Story = {
  render: () => (
    <div className="grid grid-cols-3 gap-8 place-items-center min-h-75">
      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="outline">Top</Button>
        </HoverCardTrigger>
        <HoverCardContent side="top" className="w-64">
          <p className="text-sm">
            This hover card appears above the trigger element.
          </p>
        </HoverCardContent>
      </HoverCard>

      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="outline">Right</Button>
        </HoverCardTrigger>
        <HoverCardContent side="right" className="w-64">
          <p className="text-sm">
            This hover card appears to the right of the trigger element.
          </p>
        </HoverCardContent>
      </HoverCard>

      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="outline">Bottom</Button>
        </HoverCardTrigger>
        <HoverCardContent side="bottom" className="w-64">
          <p className="text-sm">
            This hover card appears below the trigger element.
          </p>
        </HoverCardContent>
      </HoverCard>

      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="outline">Left</Button>
        </HoverCardTrigger>
        <HoverCardContent side="left" className="w-64">
          <p className="text-sm">
            This hover card appears to the left of the trigger element.
          </p>
        </HoverCardContent>
      </HoverCard>
    </div>
  ),
};

// With custom delays
export const CustomDelays: Story = {
  render: () => (
    <div className="flex gap-4">
      <HoverCard openDelay={0} closeDelay={0}>
        <HoverCardTrigger asChild>
          <Button variant="outline">Instant (0ms)</Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <p className="text-sm">
            This hover card opens and closes instantly with no delay.
          </p>
        </HoverCardContent>
      </HoverCard>

      <HoverCard openDelay={200} closeDelay={100}>
        <HoverCardTrigger asChild>
          <Button variant="outline">Fast (200ms/100ms)</Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <p className="text-sm">Opens after 200ms, closes after 100ms.</p>
        </HoverCardContent>
      </HoverCard>

      <HoverCard openDelay={700} closeDelay={300}>
        <HoverCardTrigger asChild>
          <Button variant="outline">Slow (700ms/300ms)</Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <p className="text-sm">Opens after 700ms, closes after 300ms.</p>
        </HoverCardContent>
      </HoverCard>
    </div>
  ),
};

// Interactive content
export const InteractiveContent: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button variant="link">Settings Overview</Button>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">Quick Settings</h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm">Dark Mode</label>
              <Button variant="outline" size="sm">
                Toggle
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm">Notifications</label>
              <Button variant="outline" size="sm">
                Configure
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm">Language</label>
              <Button variant="outline" size="sm">
                English
              </Button>
            </div>
          </div>
          <div className="pt-2 border-t">
            <Button variant="ghost" size="sm" className="w-full">
              View All Settings →
            </Button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};

// Complex content with images
export const ComplexContent: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <div className="inline-flex items-center gap-2 cursor-pointer">
          <GlobeIcon className="h-4 w-4" />
          <span className="text-blue-600 hover:underline">View Location</span>
        </div>
      </HoverCardTrigger>
      <HoverCardContent className="w-96">
        <div className="space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold">San Francisco Office</h3>
              <p className="text-sm text-muted-foreground">Headquarters</p>
            </div>
            <Badge>Main</Badge>
          </div>

          <div className="aspect-video relative rounded-md overflow-hidden bg-muted">
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <span className="text-xs">Map Preview</span>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <EnvelopeOpenIcon className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <div>
                <p className="font-medium">Address</p>
                <p className="text-muted-foreground">
                  123 Market Street, Suite 456
                  <br />
                  San Francisco, CA 94102
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <FaceIcon className="h-4 w-4 text-muted-foreground" />
              <div>
                <span className="font-medium">Employees:</span>{' '}
                <span className="text-muted-foreground">250+</span>
              </div>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button size="sm" className="flex-1">
              Get Directions
            </Button>
            <Button size="sm" variant="outline" className="flex-1">
              Contact
            </Button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};

// Playground with controls
export const Playground: Story = {
  args: {
    openDelay: 200,
    closeDelay: 100,
  },
  render: (args) => (
    <HoverCard {...args}>
      <HoverCardTrigger asChild>
        <Button variant="outline">Hover Me</Button>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Playground Example</h4>
          <p className="text-sm text-muted-foreground">
            Use the controls to adjust the open and close delays for this hover
            card.
          </p>
          <div className="text-xs">
            <p>Open Delay: {args.openDelay}ms</p>
            <p>Close Delay: {args.closeDelay}ms</p>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};
