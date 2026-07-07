import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Alert, AlertDescription, AlertTitle } from './alert';
import { Terminal, AlertCircle, AlertTriangle } from '@/components/system';

const meta = {
  title: 'Foundations/Primitives/Alert',
  component: Alert,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'light', 'destructive', 'warning'],
      description: 'The visual style variant of the alert',
    },
    children: {
      control: 'text',
      description: 'The content of the alert',
    },
  },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default alert
export const Default: Story = {
  args: {
    children: (
      <>
        <AlertTitle>Heads up!</AlertTitle>
        <AlertDescription>
          You can add components to your app using the cli.
        </AlertDescription>
      </>
    ),
  },
};

// Light alert
export const Light: Story = {
  args: {
    variant: 'light',
    children: (
      <>
        <AlertTitle>Note</AlertTitle>
        <AlertDescription>
          This is a light alert with no background styling.
        </AlertDescription>
      </>
    ),
  },
};

// Destructive alert
export const Destructive: Story = {
  args: {
    variant: 'destructive',
    children: (
      <>
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          Your session has expired. Please log in again.
        </AlertDescription>
      </>
    ),
  },
};

// Alert with icon
export const WithIcon: Story = {
  render: () => (
    <div className="grid gap-4">
      <Alert>
        <Terminal className="h-4 w-4" />
        <AlertTitle>Heads up!</AlertTitle>
        <AlertDescription>
          You can add components to your app using the cli.
        </AlertDescription>
      </Alert>
      <Alert variant="light">
        <Terminal className="h-4 w-4" />
        <AlertTitle>Note</AlertTitle>
        <AlertDescription>
          This is a light alert with no background.
        </AlertDescription>
      </Alert>
      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          Your session has expired. Please log in again.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          Your session has expired. Please log in again.
        </AlertDescription>
      </Alert>
    </div>
  ),
};

// Alert without title
export const WithoutTitle: Story = {
  render: () => (
    <div className="grid gap-4">
      <Alert>
        <AlertDescription>
          This is an alert without a title. It can be used for simple
          informational messages.
        </AlertDescription>
      </Alert>
      <Alert variant="light">
        <AlertDescription>
          This is a light alert without a title.
        </AlertDescription>
      </Alert>
      <Alert variant="warning">
        <AlertDescription>
          Something went wrong. Please try again later.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertDescription>
          Something went wrong. Please try again later.
        </AlertDescription>
      </Alert>
    </div>
  ),
};

// Alert with only title
export const OnlyTitle: Story = {
  render: () => (
    <div className="grid gap-4">
      <Alert>
        <AlertTitle>Information Updated Successfully</AlertTitle>
      </Alert>
      <Alert variant="light">
        <AlertTitle>Light Notification</AlertTitle>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>Operation Failed</AlertTitle>
      </Alert>
    </div>
  ),
};

// All variants showcase
export const Variants: Story = {
  render: () => (
    <div className="grid gap-4">
      <Alert>
        <Terminal className="h-4 w-4" />
        <AlertTitle>Default Alert</AlertTitle>
        <AlertDescription>
          This is a default alert with an icon, title, and description.
        </AlertDescription>
      </Alert>
      <Alert variant="light">
        <Terminal className="h-4 w-4" />
        <AlertTitle>Light Alert</AlertTitle>
        <AlertDescription>
          This is a light alert with a transparent background.
        </AlertDescription>
      </Alert>
      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Warning Alert</AlertTitle>
        <AlertDescription>
          This is a warning alert indicating something to watch out for.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Destructive Alert</AlertTitle>
        <AlertDescription>
          This is a destructive alert indicating an error or warning.
        </AlertDescription>
      </Alert>
    </div>
  ),
};

// Complex content
export const ComplexContent: Story = {
  render: () => (
    <Alert>
      <Terminal className="h-4 w-4" />
      <AlertTitle>Terminal Commands Available</AlertTitle>
      <AlertDescription>
        <div className="mt-2">
          <p>You can now run the following commands:</p>
          <ul className="mt-2 list-disc list-inside space-y-1">
            <li>
              <code className="text-sm">npm install</code> - Install
              dependencies
            </li>
            <li>
              <code className="text-sm">npm run dev</code> - Start development
              server
            </li>
            <li>
              <code className="text-sm">npm run build</code> - Build for
              production
            </li>
          </ul>
        </div>
      </AlertDescription>
    </Alert>
  ),
};

// Multiple alerts
export const MultipleAlerts: Story = {
  render: () => (
    <div className="grid gap-4">
      <Alert>
        <AlertTitle>Info</AlertTitle>
        <AlertDescription>This is an informational message.</AlertDescription>
      </Alert>
      <Alert>
        <Terminal className="h-4 w-4" />
        <AlertTitle>Tip</AlertTitle>
        <AlertDescription>
          Use the terminal to run commands more efficiently.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Warning</AlertTitle>
        <AlertDescription>
          Please review your changes before proceeding.
        </AlertDescription>
      </Alert>
    </div>
  ),
};

// Playground - interactive story with all controls
export const Playground: Story = {
  args: {
    variant: 'default',
    children: (
      <>
        <Terminal className="h-4 w-4" />
        <AlertTitle>Playground Alert</AlertTitle>
        <AlertDescription>
          This is an interactive alert where you can change the variant.
        </AlertDescription>
      </>
    ),
  },
};
